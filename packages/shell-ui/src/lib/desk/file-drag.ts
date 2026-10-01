/**
 * Files from outside the app are being dragged over the desk
 * (docs/desk-documents.md §1): the desk shows where they can go — the
 * workspace (open on the desk), the Bar (attach to the message), the Stack
 * (keep in the context) — each lighting up as the drag comes over it.
 */

import { create } from "zustand";

export const useDeskFileDrag = create<{ active: boolean; set(active: boolean): void }>((set) => ({
  active: false,
  set: (active) => set((state) => (state.active === active ? state : { active })),
}));

/** A drag that carries files (from Finder, or another app), rather than text or a link. */
export function carriesFiles(data: DataTransfer | null): boolean {
  return data !== null && [...data.types].includes("Files");
}
