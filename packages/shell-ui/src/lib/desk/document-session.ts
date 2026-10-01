/**
 * A document window's file, loaded and saved (docs/desk-documents.md §3):
 * which version is on show, what the person's edits are made to, and where
 * those edits stand. Apart from FileWindow, so its rules are tested under
 * node with loads and saves answered by hand:
 *
 * - a version on show is the latest one asked for: a load that finishes
 *   after a newer one was asked for is dropped, so an edit is never made
 *   to one version and saved over another;
 * - an edit is saved over the version it was made to (`base`), and refused
 *   if the file has moved on since — the window then asks which to keep;
 * - an edit is never lost with its window: put away (or passed to another
 *   group) with an edit waiting, the edit is written as it goes, and if
 *   that is refused it is kept as a DRAFT, which the file's next window
 *   shows, asking again. Drafts last as long as the shell does.
 *
 * The session is bound to one file of one group for its life: it saves
 * there whatever the window is later shown with.
 */

import type { GroupFileContent, GroupFileWriteResult } from "@pistachio/shell-contracts/desk-agent";
import type { FileSaveState } from "./group-files";

/** An edit is saved once the person has stopped for this long (⌘S at once). */
export const SAVE_AFTER_MS = 700;

export interface SessionIo {
  load(blobId: string): Promise<GroupFileContent | null>;
  save(write: { baseBlobId: string; bytes: Uint8Array; force: boolean }): Promise<GroupFileWriteResult>;
  setTimer(run: () => void, ms: number): number;
  clearTimer(id: number): void;
}

export type SessionShown =
  | { state: "loading" }
  | { state: "missing"; reason: string }
  /** `content.blobId` is the version the edits are made to (a draft's, its own). */
  | { state: "ready"; content: GroupFileContent };

export interface SessionState {
  shown: SessionShown;
  save: FileSaveState;
  message: string | null;
  /** The file changed elsewhere and the edits here are not saved: keep them, or load the other version. */
  conflict: string | null;
}

type Serialize = () => Uint8Array | Promise<Uint8Array>;

interface Draft {
  baseBlobId: string;
  bytes: Uint8Array;
}

/** Edits whose window went before they could be saved, by group and file. */
const drafts = new Map<string, Draft>();

/** Every kept draft forgotten (tests). */
export function forgetDrafts(): void {
  drafts.clear();
}

const NOT_HERE = "This file is not here: it was added on another Mac, and is too large to sync.";
const CHANGED = "This file changed elsewhere since you began editing it.";
const KEPT = "Your edits were not saved before the window was put away: the file changed elsewhere since.";

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : fallback;
}

export class DocumentSession {
  readonly #key: string;
  readonly #io: SessionIo;
  readonly #listener: (state: SessionState) => void;
  #state: SessionState = { shown: { state: "loading" }, save: "clean", message: null, conflict: null };
  /** The version on show, or being loaded to show. */
  #requested: string | null = null;
  /** The version the edits are made to: the one on show, once it is. */
  #base: string | null = null;
  /** The file's version in the context now, as last told. */
  #latest: string | null = null;
  /** Each load's number: only the latest one's answer is shown. */
  #generation = 0;
  #pending: Serialize | null = null;
  #saving = false;
  /** The save under way: a window going waits for it, and writes over the version it makes. */
  #inflight: Promise<void> | null = null;
  /** The draft this session showed (left by an earlier window): a save of its edits clears it. */
  #adopted: Draft | null = null;
  #timer: number | null = null;
  #disposed = false;
  /** A draft kept from an earlier window, to show once this file's metadata is loaded. */
  #draft: Draft | null;

  constructor(file: { groupId: string; itemId: string }, io: SessionIo, listener: (state: SessionState) => void) {
    this.#key = `${file.groupId}:${file.itemId}`;
    this.#io = io;
    this.#listener = listener;
    this.#draft = drafts.get(this.#key) ?? null;
  }

  get state(): SessionState {
    return this.#state;
  }

  #set(patch: Partial<SessionState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    this.#listener(this.#state);
  }

  /**
   * The file's version in the group's context now, and whether its bytes
   * are here (null: the window's file is not known, or no longer in view —
   * what is shown stays, and edits still save to the file they were made to).
   */
  update(blobId: string | null, here: boolean): void {
    if (this.#disposed || blobId === null) return;
    this.#latest = blobId;
    if (!here) {
      if (this.#requested === null) this.#set({ shown: { state: "missing", reason: NOT_HERE } });
      return;
    }
    if (blobId === this.#requested || this.#saving) return;
    // Edits of its own: the other version waits until the person says which to keep.
    if (this.#pending !== null) {
      if (blobId !== this.#base) this.#set({ conflict: CHANGED, save: "conflict", message: CHANGED });
      return;
    }
    this.#load(blobId);
  }

  #load(blobId: string): void {
    this.#generation += 1;
    const generation = this.#generation;
    this.#requested = blobId;
    this.#set({ shown: { state: "loading" } });
    this.#io.load(blobId).then(
      (content) => {
        if (generation !== this.#generation || this.#disposed) return;
        if (content === null) {
          this.#set({ shown: { state: "missing", reason: NOT_HERE } });
          return;
        }
        const draft = this.#draft;
        this.#draft = null;
        if (draft !== null) {
          this.#showDraft(content, draft);
          return;
        }
        this.#base = content.blobId;
        this.#set({ shown: { state: "ready", content } });
      },
      (error: unknown) => {
        if (generation !== this.#generation || this.#disposed) return;
        this.#set({ shown: { state: "missing", reason: reasonOf(error, "This file could not be opened.") } });
      },
    );
  }

  /** A draft kept from an earlier window, shown over the file as it is now, and asked about if the file moved on. */
  #showDraft(content: GroupFileContent, draft: Draft): void {
    // The draft is what the viewer edits: the file's own bytes, or what it is shown as (a .doc's .docx).
    const shown: GroupFileContent =
      content.shown === undefined
        ? { ...content, blobId: draft.baseBlobId, bytes: draft.bytes }
        : { ...content, blobId: draft.baseBlobId, shown: { ...content.shown, bytes: draft.bytes } };
    this.#base = draft.baseBlobId;
    this.#adopted = draft;
    this.#pending = () => draft.bytes;
    if (content.blobId !== draft.baseBlobId) {
      this.#set({ shown: { state: "ready", content: shown }, conflict: KEPT, save: "conflict", message: KEPT });
      return;
    }
    this.#set({ shown: { state: "ready", content: shown }, save: "edited", message: null });
    this.#schedule();
  }

  /** The viewer changed the file: `serialize` gives its bytes as they are now. */
  edit(serialize: Serialize): void {
    if (this.#disposed) return;
    this.#pending = serialize;
    this.#set({ save: this.#state.conflict === null ? "edited" : "conflict" });
    if (this.#state.conflict === null) this.#schedule();
  }

  #schedule(): void {
    if (this.#disposed) return;
    if (this.#timer !== null) this.#io.clearTimer(this.#timer);
    this.#timer = this.#io.setTimer(() => {
      this.#timer = null;
      void this.saveNow();
    }, SAVE_AFTER_MS);
  }

  /** Save now (⌘S; Keep mine, `force`, writes over the version the file moved on to). */
  async saveNow(force = false): Promise<void> {
    if (this.#timer !== null) {
      this.#io.clearTimer(this.#timer);
      this.#timer = null;
    }
    const serialize = this.#pending;
    const base = this.#base;
    if (serialize === null || base === null || this.#disposed) return;
    if (this.#saving) {
      this.#schedule();
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await serialize();
    } catch (error) {
      this.#set({ save: "error", message: reasonOf(error, "The document could not be written") });
      return;
    }
    this.#pending = null;
    this.#saving = true;
    this.#set({ save: "saving", message: null });
    const saved = this.#write(base, bytes, force, null);
    this.#inflight = saved.then(() => undefined);
    const result = await saved;
    this.#inflight = null;
    this.#saving = false;
    if (result.ok) {
      this.#base = result.item.blobId;
      this.#requested = result.item.blobId;
      this.#set({ conflict: null, save: this.#pending === null ? "saved" : "edited", message: null });
      if (this.#pending !== null) this.#schedule();
      return;
    }
    // Not saved: the edits wait, to be kept or given up (a later edit already waiting is newer).
    this.#pending ??= () => bytes;
    if (result.reason === "changed") this.#set({ conflict: result.message, save: "conflict", message: result.message });
    else this.#set({ save: "error", message: result.message });
  }

  /**
   * One write. Saved, it clears the draft it was made from — its own (a
   * window going), or the one this session showed — and no other: a newer
   * edit kept meanwhile by the window going stays until its own write lands.
   */
  async #write(baseBlobId: string, bytes: Uint8Array, force: boolean, own: Draft | null): Promise<GroupFileWriteResult> {
    try {
      const result = await this.#io.save({ baseBlobId, bytes, force });
      const from = own ?? this.#adopted;
      if (result.ok && from !== null && drafts.get(this.#key) === from) drafts.delete(this.#key);
      if (result.ok && own === null) this.#adopted = null;
      return result;
    } catch (error) {
      return { ok: false, reason: "failed", message: reasonOf(error, "The document could not be saved") };
    }
  }

  /** Give the edits up: the file as it is now. */
  loadTheirs(): void {
    if (this.#disposed) return;
    this.#pending = null;
    this.#draft = null;
    drafts.delete(this.#key);
    this.#set({ conflict: null, save: "clean", message: null });
    const version = this.#latest ?? this.#requested;
    if (version !== null) this.#load(version);
  }

  /**
   * The window goes. An edit waiting is written as it goes — kept as a
   * draft until it is, so if the write is refused the file's next window
   * shows it again.
   */
  dispose(): void {
    if (this.#disposed) return;
    if (this.#timer !== null) this.#io.clearTimer(this.#timer);
    this.#timer = null;
    const serialize = this.#pending;
    const base = this.#base;
    this.#pending = null;
    this.#disposed = true;
    if (serialize === null || base === null) return;
    // Read now, while the viewer (and its editor) is still there.
    let taken: Uint8Array | Promise<Uint8Array>;
    try {
      taken = serialize();
    } catch {
      return;
    }
    void Promise.resolve(taken).then(
      async (bytes) => {
        // Kept at once, so a window opened meanwhile shows it; written once any save under way has landed, over the version it made.
        const draft: Draft = { baseBlobId: base, bytes };
        drafts.set(this.#key, draft);
        if (this.#inflight !== null) await this.#inflight;
        draft.baseBlobId = this.#base ?? base;
        await this.#write(draft.baseBlobId, bytes, false, draft);
      },
      () => undefined,
    );
  }
}
