/**
 * What the double sidebar's pieces share (docs/double-sidebar.md): the space
 * whose name is being edited in the card's head, and the Home tab used last.
 *
 * A space's name is edited in ONE place on the desktop since 2026-10-13: the
 * card's head (SpaceHead), whoever asks — a double-click on its tile or its
 * name, its menu's Rename, ⌘N's or New space's new space, a space made from
 * a selection — and the card turns to the space for it. The rules are the
 * old list's (TabList's setRenaming): the rail
 * alone has no room for a name, so the whole sidebar comes back (a setting);
 * hidden and away, the column is brought out first, and the field opens once
 * it is out. The edit holds the hidden column out until it is done
 * (lib/sidebar-mode.ts's `renamingSpace`).
 */

import { create } from "zustand";
import { useAppStore } from "../../store";
import { currentSpace, selectSpace } from "../../lib/desk/open";
import { sidebarModeOf, sidebarOverlays, useSidebarColumn } from "../../lib/sidebar-mode";

interface SpaceRenameState {
  /** The space whose name field is open (or about to be, the column on its way out). */
  spaceId: string | null;
  start(spaceId: string): void;
  done(): void;
}

export const useSpaceRename = create<SpaceRenameState>((set) => ({
  spaceId: null,
  start: (spaceId) => {
    const store = useAppStore.getState();
    // (A page's space goes by its page's title, and a loose tab's by its tab's: only a drawn space has a name of its own.)
    if (store.snapshot?.tabGroups.some((group) => group.id === spaceId) !== true) return;
    // Its name is edited where it is shown: the card turns to it.
    if (currentSpace() !== spaceId) selectSpace(spaceId);
    const mode = sidebarModeOf(store.settings);
    if (mode === "rail") void store.updateSettings({ layout: { sidebar: "whole" } });
    if (sidebarOverlays(mode) && !useSidebarColumn.getState().out) store.setSidebarRevealed(true);
    useSidebarColumn.getState().setRenamingSpace(true);
    set({ spaceId });
  },
  done: () => {
    useSidebarColumn.getState().setRenamingSpace(false);
    set({ spaceId: null });
  },
}));

/** Start editing a space's name in the card (see above). */
export function renameSpace(spaceId: string): void {
  useSpaceRename.getState().start(spaceId);
}

interface HomeMemoryState {
  /** The Home tab used last: what Home on the rail goes back to. */
  tabId: string | null;
  note(tabId: string): void;
}

/** The Home tab in use, noted as it changes (SpaceColumn): Home on the rail chooses it again. */
export const useHomeMemory = create<HomeMemoryState>((set, get) => ({
  tabId: null,
  note: (tabId) => {
    if (get().tabId !== tabId) set({ tabId });
  },
}));
