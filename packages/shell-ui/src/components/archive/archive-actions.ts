/**
 * The archive page's data and what its buttons do (ArchivePage): the list
 * for the active Profile, and Restore, Remove and Clear over it — apart from
 * React, so they can be driven in a test without a DOM.
 */

import type { ShellApi } from "@pistachio/shell-contracts/ipc";
import type { ArchiveEntryView } from "@pistachio/shell-contracts/tab-archive";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";

/** What the page shows. */
export interface ArchiveView {
  /** The entries, newest first; null until the first list has come. */
  entries: ArchiveEntryView[] | null;
  retentionDays: number;
  /** What went wrong with the last thing done, in the page's error note. */
  error: string | null;
  /** The host has no archive (the web): why, in its place. */
  unavailable: string | null;
}

export const ARCHIVE_VIEW_START: ArchiveView = { entries: null, retentionDays: 30, error: null, unavailable: null };

export interface ArchiveActionsHost {
  api: () => Pick<ShellApi, "tabArchive">;
  update: (change: (view: ArchiveView) => ArchiveView) => void;
  /** Restored: the tab is shown, so the page gets out of its way. */
  close: () => void;
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

export function archiveActions(spaceId: string | null, host: ArchiveActionsHost) {
  const showError = (error: string | null): void => host.update((view) => ({ ...view, error }));

  /**
   * The list again. A list read clears an error it had shown itself, but
   * not one a button's action showed (`keepError`): that one stays until
   * the next thing done (each action clears it as it starts).
   */
  const load = async (keepError = false): Promise<void> => {
    if (spaceId === null) return;
    try {
      const response = await host.api().tabArchive({ type: "list", spaceId });
      if (response.type !== "list") return;
      host.update((view) => ({ ...view, entries: response.entries, retentionDays: response.retentionDays, error: keepError ? view.error : null }));
    } catch (failure: unknown) {
      if (isShellUnsupported(failure)) host.update((view) => ({ ...view, unavailable: messageOf(failure) }));
      else showError(messageOf(failure));
    }
  };

  /**
   * Done, the page gets out of the way of the tab it shows. Declined, main
   * may say why (`reason`: a filed space the Profile has no room for), and
   * the page says it, in its error note, over the list read again — which
   * keeps it (since 2026-10-09: until then the reload cleared the note, and
   * Restore looked as if it had done nothing).
   */
  const restore = async (entryId: string, tabIndex?: number): Promise<void> => {
    showError(null);
    try {
      const response = await host.api().tabArchive({ type: "restore", entryId, ...(tabIndex === undefined ? {} : { tabIndex }) });
      if (response.type === "done" && response.ok) {
        host.close();
        return;
      }
      if (response.type === "done" && response.reason !== undefined) showError(response.reason);
      await load(true);
    } catch (failure: unknown) {
      showError(messageOf(failure));
    }
  };

  const remove = async (entryId: string): Promise<void> => {
    host.update((view) => ({ ...view, entries: view.entries?.filter((entry) => entry.id !== entryId) ?? null, error: null }));
    try {
      await host.api().tabArchive({ type: "remove", entryId });
    } catch (failure: unknown) {
      // (Its failure stays shown over the list read back.)
      showError(messageOf(failure));
      await load(true);
    }
  };

  /** Forget every entry of the Profile, once `confirmed` says so. */
  const clear = async (confirmed: () => boolean): Promise<void> => {
    if (spaceId === null || !confirmed()) return;
    showError(null);
    try {
      await host.api().tabArchive({ type: "clear", spaceId });
      await load();
    } catch (failure: unknown) {
      showError(messageOf(failure));
    }
  };

  return { load, restore, remove, clear };
}
