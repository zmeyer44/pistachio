/**
 * A document window's file (docs/desk-documents.md §2): its bytes from the
 * group's context in main, loaded once per version, and its edits saved
 * back — and what each window says of itself on its frame (saving, saved,
 * a conflict), and when its content should take the keyboard.
 */

import { create } from "zustand";
import type { GroupFileContent, GroupFileWrite, GroupFileWriteResult } from "@pistachio/shell-contracts/desk-agent";
import { nativeApi } from "../../api";

/** The last few versions loaded, so a window put away and brought back does not wait for them again. */
const CACHE = 8;
const loaded = new Map<string, Promise<GroupFileContent | null>>();

/** A context file's bytes as they are in this version (its blob): null when they are not on this Mac. */
export function loadGroupFile(groupId: string, itemId: string, blobId: string): Promise<GroupFileContent | null> {
  const key = `${itemId}:${blobId}`;
  const cached = loaded.get(key);
  if (cached !== undefined) {
    loaded.delete(key);
    loaded.set(key, cached);
    return cached;
  }
  const api = nativeApi();
  const load = api === null ? Promise.resolve(null) : api.readGroupFile(groupId, itemId);
  loaded.set(key, load);
  load.catch(() => loaded.delete(key));
  while (loaded.size > CACHE) loaded.delete(loaded.keys().next().value!);
  return load;
}

export async function saveGroupFile(write: GroupFileWrite): Promise<GroupFileWriteResult> {
  const api = nativeApi();
  if (api === null) return { ok: false, reason: "failed", message: "Documents are saved by the desktop app" };
  try {
    return await api.writeGroupFile(write);
  } catch (error) {
    return { ok: false, reason: "failed", message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "The document could not be saved" };
  }
}

/** Where a document's edits stand, as its frame says it. */
export type FileSaveState = "clean" | "edited" | "saving" | "saved" | "conflict" | "error";

export interface FileWindowState {
  save: FileSaveState;
  /** What its viewer says of it beside the title: "12 pages", "1920 × 1080". */
  detail: string | null;
  /** Why it could not be saved. */
  message: string | null;
}

interface FileWindows {
  windows: Record<string, FileWindowState>;
  /** Bumped when a window should give its content the keyboard (DeskHost.focusWindow). */
  focus: Record<string, number>;
  set(windowId: string, patch: Partial<FileWindowState>): void;
  forget(windowId: string): void;
  requestFocus(windowId: string): void;
}

const EMPTY: FileWindowState = { save: "clean", detail: null, message: null };

export const useFileWindows = create<FileWindows>((set, get) => ({
  windows: {},
  focus: {},
  set: (windowId, patch) => {
    const current = get().windows[windowId] ?? EMPTY;
    const next = { ...current, ...patch };
    if (next.save === current.save && next.detail === current.detail && next.message === current.message) return;
    set({ windows: { ...get().windows, [windowId]: next } });
  },
  forget: (windowId) => {
    if (get().windows[windowId] === undefined) return;
    const windows = { ...get().windows };
    delete windows[windowId];
    set({ windows });
  },
  requestFocus: (windowId) => set({ focus: { ...get().focus, [windowId]: (get().focus[windowId] ?? 0) + 1 } }),
}));

export function useFileWindow(windowId: string): FileWindowState {
  return useFileWindows((state) => state.windows[windowId] ?? EMPTY);
}

/** What a frame says of a document's edits. */
export function saveLabel(state: FileSaveState): string | null {
  switch (state) {
    case "edited":
      return "Edited";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "conflict":
      return "Changed elsewhere";
    case "error":
      return "Not saved";
    default:
      return null;
  }
}
