import { CircleStop, Radio, Users } from "lucide-react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { deskAvailable } from "../../lib/desk/open";
import { deskGroups, useDeskStore } from "../../lib/desk/store";
import { openLiveCard, setGuestsCanUse, shareSpace, stopSharing } from "../../lib/live/actions";
import { guestsCanBeLetUse, guestUseEntry, spaceLiveEntries } from "../../lib/live/entries";
import { liveShareNow } from "../../lib/live/store";
import { useAppStore } from "../../store";
import type { MenuEntry } from "../ContextMenu";

/**
 * A space's live entries on its menu (the rail tile's, the card head's ⋯;
 * docs/live-share.md §1): *Share live…*, or for the space shared *Show the
 * Live card* and *Stop sharing live*. Read as the menu opens. The desktop's
 * alone: hosting captures native views.
 */
export function liveSpaceEntries(groupId: string): MenuEntry[] {
  if (!deskAvailable()) return [];
  return spaceLiveEntries(liveShareNow(), groupId).map((entry): MenuEntry => {
    switch (entry) {
      case "share":
        return { label: "Share live…", icon: <Radio aria-hidden="true" />, testId: "space-share-live", onSelect: () => void shareSpace(groupId) };
      case "card":
        return { label: "Show the Live card", icon: <Radio aria-hidden="true" />, testId: "space-live-card", onSelect: () => openLiveCard("live") };
      case "stop":
        return { label: "Stop sharing live", icon: <CircleStop aria-hidden="true" />, testId: "space-stop-live", onSelect: stopSharing };
    }
  });
}

/** A page's or a terminal's window's *Guests can use this window* on its ⋯, while its space is shared live (none otherwise). */
export function liveWindowEntries(tab: BrowserTabInfo): MenuEntry[] {
  const state = liveShareNow();
  const shared = deskGroups(useAppStore.getState().snapshot).find((group) => group.id === state.groupId);
  const groupId = shared !== undefined && shared.tabIds.includes(tab.id) ? shared.id : null;
  const use = guestUseEntry(state, groupId, tab.id, guestsCanBeLetUse(tab, groupId === null ? undefined : useDeskStore.getState().saved[groupId]));
  if (use === null) return [];
  return [
    {
      label: "Guests can use this window",
      icon: <Users aria-hidden="true" />,
      checked: use.checked,
      testId: "desk-page-guests-use",
      onSelect: () => setGuestsCanUse(tab.id, !use.checked),
    },
  ];
}
