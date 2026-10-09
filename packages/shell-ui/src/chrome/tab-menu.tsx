import { BookOpen, BookOpenText, Columns2, Copy, Focus, Layers, Moon, Pin, Sparkles, SquareMinus, SquarePlus, Star, X } from "lucide-react";
import { useMemo } from "react";
import { canReadUrl, isReaderUrl } from "@pistachio/shell-contracts/reader";
import { DEFAULT_SIDEBAR_STATE, type SidebarFolder } from "@pistachio/shell-contracts/sidebar";
import { tabGroupOf, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { MenuEntry } from "../components/ContextMenu";
import { splitAvailable } from "../lib/desk/open";
import { useAppStore } from "../store";
import { useShell } from "./shell-host";
import { moveToFolderEntries } from "./tab-menu-entries";
import type { ChromeTab } from "./tabs";

export { moveToFolderEntries } from "./tab-menu-entries";

/**
 * The right-click menu of one live tab: pinning, favoriting, moving to a
 * folder, duplicating, splitting and closing, declared once. The sidebar
 * keeps its own multi-selection and pin/folder menus; a single tab's menu
 * is this — on a desk, with the desk's own entries first
 * (components/desk/DeskSidebarControls.tsx: deskTabEntries) and
 * TabMenuOptions.desk.
 */

/** The active Space's folders, off the shelf snapshot. */
export function useShelfFolders(): SidebarFolder[] {
  const entries = useAppStore((s) => (s.snapshot?.sidebar ?? DEFAULT_SIDEBAR_STATE).entries);
  return useMemo(() => entries.filter((e): e is SidebarFolder => e.kind === "folder"), [entries]);
}

const NO_GROUPS: readonly TabGroupInfo[] = [];

/**
 * A day tab's tab-group entries (docs/tab-tidy.md §3.3): out of the group it
 * is in, into a new one, or into any other. Flat, as the folder entries are.
 * A pinned or favorite tab has none — it belongs to its shelf entry.
 */
function groupEntries(
  tab: ChromeTab,
  groups: readonly TabGroupInfo[],
  command: ReturnType<typeof useAppStore.getState>["tabGroupCommand"],
  onNewGroup: ((groupId: string) => void) | undefined,
  moveTo: (groupId: string) => void,
): MenuEntry[] {
  if (tab.kind !== "human" || tab.anchorId !== null) return [];
  const own = tabGroupOf(groups, tab.id);
  return [
    { separator: true },
    ...(own === null
      ? []
      : [
          {
            label: `Remove from “${own.title}”`,
            icon: <SquareMinus aria-hidden="true" />,
            onSelect: () => void command({ type: "removeTab", tabId: tab.id }),
          },
        ]),
    {
      label: "New space with this tab",
      icon: <SquarePlus aria-hidden="true" />,
      onSelect: () => {
        const id = crypto.randomUUID();
        void command({ type: "create", id, tabIds: [tab.id] }).then((result) => {
          if (result !== null) onNewGroup?.(id);
        });
      },
    },
    ...groups
      .filter((group) => group.id !== own?.id)
      .map<MenuEntry>((group) => ({
        label: `Add to “${group.title}”`,
        icon: <Layers aria-hidden="true" />,
        onSelect: () => moveTo(group.id),
      })),
  ];
}

export interface TabMenuOptions {
  /** A group made from the tab: the chrome names it, or starts its rename (useNewGroupNaming). */
  onNewGroup?: (groupId: string) => void;
  /**
   * Opened on the desk, the sidebar being its dock (always, on the desktop,
   * since 2026-10-09): a tab whose window is out is on screen and cannot be
   * suspended, and a tab added to another group goes the way the desk sends
   * it (its window flying into that group's row). (A split view means
   * nothing there either: splitAvailable, the surface's, not this.)
   */
  desk?: {
    onDesk(tabId: string): boolean;
    moveToGroup(tabId: string, groupId: string): void;
  };
}

export function useTabMenu(options: TabMenuOptions = {}): (tab: ChromeTab) => MenuEntry[] {
  const folders = useShelfFolders();
  const groups = useAppStore((s) => s.snapshot?.tabGroups ?? NO_GROUPS);
  const tabGroupCommand = useAppStore((s) => s.tabGroupCommand);
  const { onNewGroup, desk } = options;
  const selectTab = useAppStore((s) => s.selectTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const suspendTab = useAppStore((s) => s.suspendTab);
  const setForcedFocus = useAppStore((s) => s.setForcedFocus);
  const setSplit = useAppStore((s) => s.setSplit);
  const splitWith = useAppStore((s) => s.splitWith);
  const duplicateTab = useAppStore((s) => s.duplicateTab);
  const toggleReaderView = useAppStore((s) => s.toggleReaderView);
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);
  const { run } = useShell();

  return (tab: ChromeTab): MenuEntry[] => [
    {
      label: "Pin tab",
      icon: <Pin aria-hidden="true" />,
      disabled: tab.kind !== "human",
      onSelect: () =>
        void sidebarCommand({
          type: "pinTab",
          tabId: tab.id,
          folderId: null,
          index: 10_000,
        }),
    },
    {
      label: "Add to favorites",
      icon: <Star aria-hidden="true" />,
      disabled: tab.kind !== "human",
      onSelect: () => void sidebarCommand({ type: "addFavorite", source: { tabId: tab.id } }),
    },
    ...moveToFolderEntries(
      folders,
      null,
      (folderId) =>
        void sidebarCommand({
          type: "pinTab",
          tabId: tab.id,
          folderId,
          index: 10_000,
        }),
    ),
    ...groupEntries(tab, groups, tabGroupCommand, onNewGroup, (groupId) =>
      desk !== undefined ? desk.moveToGroup(tab.id, groupId) : void tabGroupCommand({ type: "addTab", groupId, tabId: tab.id }),
    ),
    { separator: true },
    {
      label: "Duplicate tab",
      icon: <Copy aria-hidden="true" />,
      disabled: tab.kind !== "human",
      onSelect: () => void duplicateTab(tab.id),
    },
    {
      label: isReaderUrl(tab.url) ? "Hide reader" : "Reader view",
      icon: isReaderUrl(tab.url) ? <BookOpenText aria-hidden="true" /> : <BookOpen aria-hidden="true" />,
      disabled: tab.kind !== "human" || !canReadUrl(tab.url),
      onSelect: () => void toggleReaderView(tab.id),
    },
    // (Splits are the web's alone since 2026-10-09: a desk lays its windows out by hand. Asked of the surface, not of
    // `desk`, which a menu opened in a cold start's first frames may not have yet.)
    ...(!splitAvailable()
      ? []
      : [
          {
            label: tab.splitGroup !== null ? "Close split view" : tab.active ? "Open in split view" : "Split with active tab",
            icon: <Columns2 aria-hidden="true" />,
            onSelect: () => {
              if (tab.splitGroup !== null) {
                void (async () => {
                  if (!tab.active && !tab.split) await selectTab(tab.id);
                  await setSplit("single");
                })();
              } else void splitWith(tab.id, "right");
            },
          },
        ]),
    {
      label: "Ask Pistachio about this tab",
      icon: <Sparkles aria-hidden="true" />,
      disabled: tab.kind !== "human",
      onSelect: () => run({ type: "delegate", tabId: tab.id }),
    },
    {
      label: tab.lifecycle === "suspended" ? "Suspended" : "Suspend tab",
      icon: <Moon aria-hidden="true" />,
      disabled: tab.kind !== "human" || tab.lifecycle === "suspended" || tab.active || tab.split || desk?.onDesk(tab.id) === true,
      onSelect: () => void suspendTab(tab.id),
    },
    // Only a host that can hold a page in focus reports the flag at all.
    ...(tab.forcedFocus === undefined
      ? []
      : [
          {
            label: "Force focus",
            icon: <Focus aria-hidden="true" />,
            checked: tab.forcedFocus,
            onSelect: () => void setForcedFocus(tab.id, !tab.forcedFocus),
          },
        ]),
    { separator: true },
    {
      label: "Close tab",
      icon: <X aria-hidden="true" />,
      danger: true,
      onSelect: () => void closeTab(tab.id),
    },
  ];
}
