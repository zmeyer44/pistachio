import { useEffect, useRef } from "react";
import { AppWindow, Columns2, Pencil, Plus, Ungroup, X } from "lucide-react";
import { DEFAULT_TAB_GROUP_TITLE, type TabGroupColor, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { shellApi } from "../api";
import type { MenuEntry } from "../components/ContextMenu";
import { useAppStore } from "../store";
import { deskAvailable, toggleDesk } from "../lib/desk/open";
import { useDeskStore } from "../lib/desk/store";

/**
 * A tab group's menu and its close, declared once for both layouts — the
 * sidebar's group row (components/TabGroupRow.tsx) and the strip's chip
 * (components/TabStrip.tsx) — the way chrome/tab-menu.tsx is for one tab
 * (docs/tab-tidy.md §3.3). A desk's dock opens it for another group's icon
 * (components/desk/DeskDock.tsx: `desk`).
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
  /**
   * Opened from a desk's dock, for another of the Space's groups: its desk
   * is `open`ed in place of this one (a new tab in it comes out there), and
   * holding the sidebar's row open has no row to hold.
   */
  desk?: { open(groupId: string): void };
}): {
  menu: (group: TabGroupInfo) => MenuEntry[];
  /** Close a group; it is filed in the archive, so the notice that says so can take it back (§3.5). */
  close: (group: TabGroupInfo) => void;
} {
  const tabGroupCommand = useAppStore((s) => s.tabGroupCommand);
  const showNotice = useAppStore((s) => s.showNotice);
  const deskGroupId = useDeskStore((s) => s.groupId);
  const { onRename, desk } = options;

  const close = (group: TabGroupInfo): void => {
    const count = group.tabIds.length;
    void tabGroupCommand({ type: "close", groupId: group.id }).then((result) => {
      if (result === null) return;
      const entryId = result.archivedEntryId;
      showNotice(
        `Closed “${group.title}” · ${String(count)} ${count === 1 ? "tab" : "tabs"}`,
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
      label: "New tab in group",
      icon: <Plus aria-hidden="true" />,
      onSelect: () => {
        // On a desk, the new tab is chosen in a group not the desk's: the desk passes to that group first, and it comes out there.
        desk?.open(group.id);
        void tabGroupCommand({ type: "newTab", groupId: group.id });
      },
    },
    {
      label: group.tabIds.length > 4 ? "Open 4 most recent as split view" : "Open as split view",
      icon: <Columns2 aria-hidden="true" />,
      disabled: group.tabIds.length < 2,
      onSelect: () => void tabGroupCommand({ type: "openAsSplit", groupId: group.id }),
    },
    ...(deskAvailable()
      ? [
          {
            label: deskGroupId === group.id ? "Leave the desk" : "Open as desk",
            icon: <AppWindow aria-hidden="true" />,
            onSelect: () => (desk !== undefined ? desk.open(group.id) : toggleDesk(group.id)),
          },
        ]
      : []),
    ...(desk !== undefined
      ? []
      : [
          {
            label: "Keep open",
            checked: group.open,
            onSelect: () => void tabGroupCommand({ type: "setOpen", groupId: group.id, open: !group.open }),
          },
        ]),
    { separator: true },
    {
      label: "Ungroup tabs",
      icon: <Ungroup aria-hidden="true" />,
      onSelect: () => void tabGroupCommand({ type: "ungroup", groupId: group.id }),
    },
    {
      label: "Close group",
      icon: <X aria-hidden="true" />,
      danger: true,
      onSelect: () => close(group),
    },
  ];

  return { menu, close };
}
