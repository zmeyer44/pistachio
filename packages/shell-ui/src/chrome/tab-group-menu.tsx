import { useEffect, useRef } from "react";
import { Columns2, Pencil, Plus, Ungroup, X } from "lucide-react";
import { DEFAULT_TAB_GROUP_TITLE, type TabGroupColor, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { shellApi } from "../api";
import type { MenuEntry } from "../components/ContextMenu";
import { useAppStore } from "../store";
import { splitAvailable } from "../lib/desk/open";

/**
 * A space's (tab group's) menu and its close, declared once for the
 * sidebar's group row (components/TabGroupRow.tsx), the way
 * chrome/tab-menu.tsx is for one tab (docs/tab-tidy.md §3.3). Since
 * 2026-10-09 (docs/spaces.md) it says "space", it has no "Open as desk" or
 * "Leave the desk" (the desk is always up; the row itself chooses the
 * space), and "Open as split view" is the web's.
 */

/** The colours in the order the menu lays them out, with the words a screen reader says. */
export const TAB_GROUP_SWATCHES: ReadonlyArray<{ id: TabGroupColor; label: string }> = [
  { id: "gray", label: "Gray" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "amber", label: "Amber" },
  { id: "pink", label: "Pink" },
  { id: "red", label: "Red" },
  { id: "orange", label: "Orange" },
];

const NO_GROUPS: readonly TabGroupInfo[] = [];

/**
 * What happens to a group once this chrome has made it (docs/tab-tidy.md
 * §3.3). The host names it from its tabs when it can — the row says
 * "Naming…" meanwhile — and only when it cannot, or the asking came to
 * nothing, is the person handed the name field, as they always used to be.
 * Returns `track`: call it with the new group's id once the command is back.
 */
export function useNewGroupNaming(startRenaming: (groupId: string) => void): (groupId: string) => void {
  const groups = useAppStore((s) => s.snapshot?.tabGroups ?? NO_GROUPS);
  const waiting = useRef(new Map<string, { seen: boolean }>());
  const start = useRef(startRenaming);
  start.current = startRenaming;
  const settle = (list: readonly TabGroupInfo[]): void => {
    for (const [groupId, state] of [...waiting.current]) {
      const group = list.find((candidate) => candidate.id === groupId);
      if (group === undefined) {
        // Not published yet — or, once it has been seen, closed before it was named.
        if (state.seen) waiting.current.delete(groupId);
        continue;
      }
      state.seen = true;
      if (group.naming === true) continue;
      waiting.current.delete(groupId);
      if (group.title === DEFAULT_TAB_GROUP_TITLE) start.current(groupId);
    }
  };
  useEffect(() => settle(groups), [groups]);
  return (groupId) => {
    waiting.current.set(groupId, { seen: false });
    settle(useAppStore.getState().snapshot?.tabGroups ?? NO_GROUPS);
  };
}

export function useTabGroupMenu(options: {
  onRename: (groupId: string) => void;
}): {
  menu: (group: TabGroupInfo) => MenuEntry[];
  /** Close a group; it is filed in the archive, so the notice that says so can take it back (§3.5). */
  close: (group: TabGroupInfo) => void;
} {
  const tabGroupCommand = useAppStore((s) => s.tabGroupCommand);
  const showNotice = useAppStore((s) => s.showNotice);
  const { onRename } = options;

  const close = (group: TabGroupInfo): void => {
    const count = group.tabIds.length;
    void tabGroupCommand({ type: "close", groupId: group.id }).then((result) => {
      if (result === null) return;
      const entryId = result.archivedEntryId;
      // (An empty space is filed too, with its Stack and conversation: no count to say then.)
      showNotice(
        count === 0 ? `Closed “${group.title}”` : `Closed “${group.title}” · ${String(count)} ${count === 1 ? "tab" : "tabs"}`,
        entryId === null ? {} : { action: { label: "Undo", run: () => void shellApi().tabArchive({ type: "restore", entryId }) } },
      );
    });
  };

  const menu = (group: TabGroupInfo): MenuEntry[] => [
    {
      label: "Rename",
      icon: <Pencil aria-hidden="true" />,
      onSelect: () => onRename(group.id),
    },
    {
      swatches: TAB_GROUP_SWATCHES,
      selected: group.color,
      onPick: (color) => void tabGroupCommand({ type: "recolor", groupId: group.id, color: color as TabGroupColor }),
    },
    { separator: true },
    {
      // In another space than the current one, the new tab is in use there, and the desk passes to it (main's).
      label: "New tab in space",
      icon: <Plus aria-hidden="true" />,
      onSelect: () => void tabGroupCommand({ type: "newTab", groupId: group.id }),
    },
    ...(splitAvailable()
      ? [
          {
            label: group.tabIds.length > 4 ? "Open 4 most recent as split view" : "Open as split view",
            icon: <Columns2 aria-hidden="true" />,
            disabled: group.tabIds.length < 2,
            onSelect: () => void tabGroupCommand({ type: "openAsSplit", groupId: group.id }),
          },
        ]
      : []),
    {
      label: "Keep open",
      checked: group.open,
      onSelect: () => void tabGroupCommand({ type: "setOpen", groupId: group.id, open: !group.open }),
    },
    { separator: true },
    {
      // Each tab its own space again; the space itself stays, empty, if it holds a Stack or a conversation (main's).
      label: "Release the tabs",
      icon: <Ungroup aria-hidden="true" />,
      disabled: group.tabIds.length === 0,
      onSelect: () => void tabGroupCommand({ type: "ungroup", groupId: group.id }),
    },
    {
      label: "Close space",
      icon: <X aria-hidden="true" />,
      danger: true,
      onSelect: () => close(group),
    },
  ];

  return { menu, close };
}
