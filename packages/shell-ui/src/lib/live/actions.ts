/**
 * The live share's ways in, carried out (docs/live-share.md §1): share a
 * space (its menu, `/share`), stop, open the Live card, draw (`/draw`, the
 * card's pen). What each does is decided in lib/live/entries.ts; this asks
 * the person where it must (one share per Mac: another space's stops first),
 * takes the desk to the space shared, and talks to main.
 */

import type { ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { tabGroupTitle } from "@pistachio/shell-contracts/tab-groups";
import { useAppStore } from "../../store";
import { anchorOf, useDeskChrome, type DeskAnchor } from "../desk/chrome";
import { selectSpace } from "../desk/open";
import { deskGroups, groupPageOf } from "../desk/store";
import { drawActionFor, hostNameFrom, shareActionFor } from "./entries";
import { liveShareNow, livePen, sendLive, setLiveCardTab, setLiveRequested, useLiveShareStore } from "./store";

/** A space's name as the sidebar draws it: a loose tab's or a page's space goes by its tab's title. */
export function spaceNameOf(snapshot: ShellSnapshot | null, groupId: string | null): string {
  const group = groupId === null ? undefined : deskGroups(snapshot).find((candidate) => candidate.id === groupId);
  if (group === undefined) return "this space";
  if (group.loose !== true && group.anchorId === undefined) return group.title;
  const own = group.anchorId === undefined ? group.tabIds[0] : groupPageOf(group, snapshot?.tabs ?? []);
  return tabGroupTitle(snapshot?.tabs.find((tab) => tab.id === own)?.title ?? "");
}

/**
 * Share `groupId` live — or, shared already, show its card. Another space's
 * share stops first, once the person agrees. The desk goes to the space (a
 * host shares where they are: shared from another space's menu, it comes to
 * the front), the card opens saying "Starting…", and main makes the link,
 * copies it, and goes live (or says why it could not, in the card).
 */
export async function shareSpace(groupId: string): Promise<void> {
  const action = shareActionFor(liveShareNow(), groupId);
  if (action.kind === "open") {
    openLiveCard("live");
    return;
  }
  const store = useAppStore.getState();
  if (action.replaces !== null) {
    const was = spaceNameOf(store.snapshot, action.replaces);
    if (!window.confirm(`Stop sharing “${was}” live and share “${spaceNameOf(store.snapshot, groupId)}” instead? Guests in “${was}” will be let go.`)) return;
  }
  selectSpace(groupId);
  setLiveRequested(groupId);
  openLiveCard("live");
  const hostName = hostNameFrom(store.account.deviceName);
  try {
    await sendLive({ type: "start", groupId, ...(hostName === null ? {} : { hostName }) });
  } catch {
    store.showNotice("Couldn't start sharing: Pistachio's main process didn't answer", { tone: "warning" });
  } finally {
    // Main has answered — live, or an error the card says: its state speaks from here.
    if (useLiveShareStore.getState().requested?.groupId === groupId) setLiveRequested(null);
  }
}

/** Stop sharing: the room ends for everyone, the link dies, the card goes. */
export function stopSharing(): void {
  setLiveRequested(null);
  useDeskChrome.getState().closeCard("live");
  void sendLive({ type: "stop" });
}

/**
 * The Live card over the desk, beside the shared space's tile on the rail
 * (Home's, for a space of Home's), or the sidebar where neither is drawn.
 */
export function openLiveCard(tab?: "live" | "chat"): void {
  if (tab !== undefined) setLiveCardTab(tab);
  const state = liveShareNow();
  const groupId = state.groupId ?? useLiveShareStore.getState().requested?.groupId ?? null;
  useDeskChrome.getState().openCard({ kind: "live", anchor: cardAnchor(groupId), pinned: true });
}

/** `/draw`, the card's pen: draw over the shared desk with the pen last used, or give the desk back — or say why not. */
export function toggleLiveDrawing(): void {
  const state = liveShareNow();
  const store = useAppStore.getState();
  const action = drawActionFor(state, store.snapshot?.currentGroupId ?? null, livePen(), spaceNameOf(store.snapshot, state.groupId));
  if (action.kind === "explain") {
    store.showNotice(action.message);
    return;
  }
  // Drawing, the whole desk is the pen's (the live-host window takes the pointer): the card goes, to draw on what it covered.
  if (action.drawing !== null) useDeskChrome.getState().closeCard("live");
  void sendLive({ type: "setDrawing", drawing: action.drawing });
}

/** Guests may (or may no longer) use this window. */
export function setGuestsCanUse(windowId: string, allowed: boolean): void {
  void sendLive({ type: "setControllable", windowId, allowed });
}

function cardAnchor(groupId: string | null): DeskAnchor {
  const pane = document.querySelector<HTMLElement>("[data-testid='sidebar-pane']");
  const tile = groupId === null ? null : (pane?.querySelector<HTMLElement>(`[data-testid='rail-space'][data-group-id='${CSS.escape(groupId)}']`) ?? null);
  const el = tile ?? pane?.querySelector<HTMLElement>("[data-testid='rail-home']") ?? document.querySelector<HTMLElement>("[data-testid='sidebar-motion-slot']");
  return el === null || el === undefined ? { x: 0, y: 0, w: 0, h: 0 } : anchorOf(el);
}
