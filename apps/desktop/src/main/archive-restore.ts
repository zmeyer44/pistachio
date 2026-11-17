/**
 * Bringing an archive entry back (docs/tab-tidy.md §3.5; docs/spaces.md §1,
 * "Close space"): a tab, one tab of a filed space, or a whole space — its
 * tabs asleep, and the space itself with its own id when that is free, so
 * its Stack and conversation (kept by that id) come back with it. The tab
 * archive's "restore" (index.ts), here so it can be tested without Electron.
 */

import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { BrowserController } from "./browser-controller";
import type { TabArchiveStore } from "./tab-archive-store";

export type ArchiveRestoreHost = Pick<
  BrowserController,
  "activeSpaceId" | "hasRoomForSpace" | "hasRoomForTabs" | "restoreArchivedTabs" | "createTabGroup" | "commitTidy" | "selectTab" | "selectGroup"
>;

/** Why a filed space did not come back: the Profile holds as many spaces as it may. */
export const NO_ROOM_FOR_SPACE = "There is no room for another space here. Close one, then restore this again.";
/** Why a filed space did not come back: the Profile's session would not keep its tabs beside the ones open (BrowserController.hasRoomForTabs). */
export const NO_ROOM_FOR_TABS = "There are too many tabs open here for that space to come back. Close some, then restore this again.";

/**
 * Restore `entryId` (`tabIndex`: that one tab of a filed space) into its
 * Profile (Space), the active one when `profileExists` says its own is gone.
 * The entry is spent only once what it held is back: a space the Profile has
 * no room for (MAX_TAB_GROUPS_PER_SPACE) is refused before anything is
 * restored, and its entry stays to be restored once a space is freed. (Until
 * 2026-10-09 the entry went first: an empty space restored at the cap was
 * lost with it, and one with tabs came back as loose tabs.) So is a space
 * whose tabs the Profile's session would not keep beside the ones open
 * (hasRoomForTabs): restored, they would be dropped at the next save and
 * gone at the next launch, the entry spent.
 *
 * `quiet`: back, and nothing brought in front — the Undo of a close nobody
 * pressed (an extension's, docs/primitives.md §2.6) puts the space back where
 * it was, which was not in front.
 */
export async function restoreArchiveEntry(
  archive: Pick<TabArchiveStore, "get" | "remove" | "removeGroupTab">,
  host: ArchiveRestoreHost,
  request: { entryId: string; tabIndex?: number; quiet?: boolean },
  profileExists: (spaceId: string) => boolean,
): Promise<{ ok: boolean; reason?: string }> {
  const entry = archive.get(request.entryId);
  if (entry === null) return { ok: false };
  const spaceId = profileExists(entry.spaceId) ? entry.spaceId : host.activeSpaceId();
  let tabIds: string[];
  let space: TabGroupInfo | null = null;
  if (entry.kind === "group" && request.tabIndex !== undefined) {
    // (One tab of it, as a loose tab: no space is made, and the entry keeps the rest — a space's own entry even with no
    // tab left, the space alone (TabArchiveStore.removeGroupTab). The space is not remade around this one tab: its id
    // taken then, restoring the rest whole would make a second space under a new one.)
    const tab = archive.removeGroupTab(entry.id, request.tabIndex);
    tabIds = tab === null ? [] : host.restoreArchivedTabs(spaceId, [tab]);
  } else if (entry.kind === "tab") {
    tabIds = host.restoreArchivedTabs(spaceId, [entry.tab]);
    if (tabIds.length > 0) archive.remove(entry.id);
  } else {
    if (!host.hasRoomForSpace(spaceId)) return { ok: false, reason: NO_ROOM_FOR_SPACE };
    if (!host.hasRoomForTabs(spaceId, entry.tabs.length)) return { ok: false, reason: NO_ROOM_FOR_TABS };
    tabIds = host.restoreArchivedTabs(spaceId, entry.tabs);
    // The space comes back as itself — its id when that is free, so its Stack and conversation are there with it
    // (since 2026-10-09; an entry filed before has no id, and gets a new one).
    const made = { ...entry.group, tabIds, spaceId };
    space = (entry.groupId === undefined ? null : host.createTabGroup({ ...made, id: entry.groupId })) ?? host.createTabGroup(made);
    // Spent once anything of it is back (its tabs, loose, should the space still not be made: never twice).
    if (space !== null || tabIds.length > 0) archive.remove(entry.id);
  }
  host.commitTidy();
  const [first] = tabIds;
  if (request.quiet !== true && spaceId === host.activeSpaceId()) {
    if (first !== undefined) await host.selectTab(first);
    // A space filed empty comes back empty, in front.
    else if (space !== null) await host.selectGroup(space.id);
  }
  const ok = first !== undefined || space !== null;
  return ok ? { ok } : { ok, reason: "That could not be restored." };
}
