/**
 * What the shell does about spaces that are away (docs/primitives.md §2):
 * the two commands a person can press — Send away, on a space's menu; Bring
 * back, on the Away card and the notice — and the notice main's word of one
 * raises. What they say is ./away-spaces.
 */

import type { AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import { useAppStore } from "../store";
import { shellApi } from "../api";
import { awayNoticeText } from "./away-spaces";
import { selectSpace } from "./desk/open";

/** Send a space away, as its menu does: main says so in a notice of its own; a refusal is said here, in main's sentence. */
export function sendSpaceAway(groupId: string): void {
  const store = useAppStore.getState();
  void store.tabGroupCommand({ type: "sendAway", groupId }).then((result) => {
    if (result?.refused !== undefined) useAppStore.getState().showNotice(result.refused, { tone: "warning" });
  });
}

/** Bring an away space back, in front (main's `bringBack`); a refusal — no room for it — is said in main's sentence. */
export function bringSpaceBack(groupId: string): void {
  const store = useAppStore.getState();
  // (A page over the desk — Settings — steps aside for the space coming up, as it does for one chosen: selectSpace.)
  store.closePage();
  void store.tabGroupCommand({ type: "bringBack", groupId }).then((result) => {
    if (result?.refused !== undefined) useAppStore.getState().showNotice(result.refused, { tone: "warning" });
  });
}

/**
 * Main's word that a space went away, or came back by the clock or by an
 * extension (ShellCommand `spaceAway`; `broughtBy`, the extension's name):
 * a notice with the way back — Bring back for one sent, Show for one
 * returned (it comes back at the rail's foot, never in front) — as Tidy's
 * carries Undo.
 */
/** What a notice says of a space something other than the person closed: `Closed “Trip planning” · 5 tabs · Idle spaces`. */
export function closedNoticeText(title: string, tabCount: number, by: string): string {
  return [`Closed “${title}”`, ...(tabCount === 0 ? [] : [`${String(tabCount)} ${tabCount === 1 ? "tab" : "tabs"}`]), by].join(" · ");
}

/**
 * A space an extension closed into the archive (docs/primitives.md §2.6): said as the person's own Close space is,
 * with who did it and the same way back — Undo restores the archive's entry.
 */
export function announceClosed(title: string, tabCount: number, entryId: string | null, by: string): void {
  useAppStore.getState().showNotice(closedNoticeText(title, tabCount, by), entryId === null ? {} : { action: { label: "Undo", run: () => void shellApi().tabArchive({ type: "restore", entryId }) } });
}

/** What a notice says of a space something other than the person made: `New space “Chess time” · 1 tab · Chess time`. */
export function madeNoticeText(title: string, tabCount: number, by: string): string {
  return [`New space “${title}”`, ...(tabCount === 0 ? [] : [`${String(tabCount)} ${tabCount === 1 ? "tab" : "tabs"}`]), by].join(" · ");
}

/**
 * A space an extension made (docs/primitives.md §2.7): it stands on the rail behind what is in front — nobody is
 * moved by code — so it is said, with who made it and the way to it: Show.
 */
export function announceMade(groupId: string, title: string, tabCount: number, by: string): void {
  useAppStore.getState().showNotice(madeNoticeText(title, tabCount, by), { tone: "success", action: { label: "Show", run: () => selectSpace(groupId) } });
}

export function announceAway(event: "sent" | "returned", space: AwaySpaceInfo, broughtBy?: string): void {
  const message = awayNoticeText(event, space, Date.now(), broughtBy === undefined ? {} : { broughtBy });
  const groupId = space.id;
  useAppStore.getState().showNotice(
    message,
    event === "sent" ? { action: { label: "Bring back", run: () => bringSpaceBack(groupId) } } : { tone: "success", action: { label: "Show", run: () => selectSpace(groupId) } },
  );
}
