/**
 * The favorites and pins open on a page the person brought into a space
 * (BrowserTabInfo.linkedAnchorId, since 2026-10-14; docs/spaces.md §1): what
 * the favorite's tile and the pin's row draw them by — open there, in that
 * space's colour, named in their tooltip. The rule is rail-model.ts's
 * entryLinksOf; this is it over the snapshot, for a component.
 */

import { useMemo } from "react";
import { tabGroupTitle, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { groupPageOf } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import { entryLinksOf, type EntryLink } from "./rail-model";

const NO_LINKS: ReadonlyMap<string, EntryLink> = new Map();

export function useEntryLinks(): ReadonlyMap<string, EntryLink> {
  const tabs = useAppStore((state) => state.snapshot?.tabs);
  const tabGroups = useAppStore((state) => state.snapshot?.tabGroups);
  const anchorGroups = useAppStore((state) => state.snapshot?.anchorGroups);
  return useMemo(() => {
    if (tabs === undefined || !tabs.some((tab) => tab.linkedAnchorId !== undefined)) return NO_LINKS;
    // A page's space goes by its page's name, as its tile on the rail does.
    const pageTitle = (group: TabGroupInfo): string => tabGroupTitle(tabs.find((tab) => tab.id === groupPageOf(group, tabs))?.title ?? "");
    return entryLinksOf(tabs, [...(tabGroups ?? []), ...(anchorGroups ?? [])], pageTitle);
  }, [tabs, tabGroups, anchorGroups]);
}
