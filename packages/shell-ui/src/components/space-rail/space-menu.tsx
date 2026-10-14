import { LayoutPanelLeft, Plus, Ungroup, X } from "lucide-react";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { useTabGroupMenu } from "../../chrome/tab-group-menu";
import { groupPageOf } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import type { MenuEntry } from "../ContextMenu";
import { renameSpace } from "./column-state";
import { dayUnitsOf, type RailSpace } from "./rail-model";

/** What a page's space's menu does (pageSpaceMenu): main's commands, or a stand-in in a test. */
export interface PageSpaceActions {
  newTab(): void;
  ownSpace(): void;
  release(): void;
  closeBeside(tabIds: readonly string[]): void;
}

/**
 * A page's space's menu (docs/double-sidebar.md §1): a favorite's or pin's
 * page with tabs opened beside it. It is not a space of its own — it goes by
 * its page's title and is drawn in the page's grey, and main's group
 * commands on it miss: a name or a colour is the page group's, shown
 * nowhere; "Keep open" holds a list row the card does not draw; closing it
 * closes the page too and files it as an unnamed space. So what it offers is
 * what fits a page with company: a new tab beside it; making it a space of
 * its own (bringDown: the page lets go of its entry, which stays, closed,
 * and the group is an ordinary space, named after the entry and coloured —
 * which can then be renamed and recoloured); releasing the tabs beside it to
 * Today (main's ungroup: the page stays its entry's); and closing them.
 * (Until 2026-10-13 it had the whole space menu.)
 */
export function pageSpaceMenu(group: TabGroupInfo, pageTabId: string | null, act: PageSpaceActions): MenuEntry[] {
  const beside = group.tabIds.filter((tabId) => tabId !== pageTabId);
  return [
    { label: "New tab in space", icon: <Plus aria-hidden="true" />, onSelect: act.newTab },
    { separator: true },
    { label: "Make it a space of its own", icon: <LayoutPanelLeft aria-hidden="true" />, disabled: pageTabId === null, onSelect: act.ownSpace },
    { label: "Release the tabs", icon: <Ungroup aria-hidden="true" />, disabled: beside.length === 0, onSelect: act.release },
    { separator: true },
    {
      label: beside.length === 1 ? "Close the tab beside it" : "Close the tabs beside it",
      icon: <X aria-hidden="true" />,
      danger: true,
      disabled: beside.length === 0,
      onSelect: () => act.closeBeside(beside),
    },
  ];
}

/**
 * A rail space's menu, for its tile's right click and its head's ⋯: a drawn
 * space's own (chrome/tab-group-menu.tsx, renamed in the card's head), or a
 * page's space's (pageSpaceMenu).
 */
export function useSpaceMenu(): (space: RailSpace) => MenuEntry[] {
  const { menu: groupMenu } = useTabGroupMenu({ onRename: renameSpace });
  return (space) => {
    if (!space.page) return groupMenu(space.group);
    const store = useAppStore.getState();
    const { group } = space;
    const pageTabId = groupPageOf(group, store.snapshot?.tabs ?? []);
    const anchorId = group.anchorId;
    return pageSpaceMenu(group, pageTabId, {
      newTab: () => void store.tabGroupCommand({ type: "newTab", groupId: group.id }),
      // (Set down after the day's last unit: its tile goes to the foot of the drawn spaces.)
      ownSpace: () => {
        const snapshot = useAppStore.getState().snapshot;
        if (anchorId !== undefined && snapshot !== null) void store.sidebarCommand({ type: "bringDown", anchorId, index: dayUnitsOf(snapshot).length });
      },
      release: () => void store.tabGroupCommand({ type: "ungroup", groupId: group.id }),
      closeBeside: (tabIds) => {
        for (const tabId of tabIds) void store.closeTab(tabId);
      },
    });
  };
}
