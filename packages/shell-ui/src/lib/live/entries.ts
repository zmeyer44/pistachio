/**
 * Where a live share is offered and what each way in does (docs/live-share.md
 * §1): a space's menu (*Share live…*, or for the space shared *Live card* and
 * *Stop sharing live*), `/share` and `/draw` in the Bar, and a page window's
 * *Guests can use this window*. Pure — the share as main holds it in, a
 * decision out — so test/live-entries.test.ts pins them; lib/live/actions.ts
 * and the menus carry them out.
 *
 * Which spaces: every space, a Home tab's too. A Home tab is a loose space —
 * a space of one, with everything a space has (docs/spaces.md §1) — so
 * `/share` in Home shares that tab's desk; a new tab opened there is a Home
 * tab of its own, another space, and the host is then away from the share
 * as on any other space. The menus that exist are the drawn spaces' and the
 * pages' spaces'; Home's tabs have the Bar.
 */

import type { LiveDrawing, LiveShareState } from "@pistachio/shell-contracts/live-share";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { isTerminalUrl } from "@pistachio/shell-contracts/terminal";
import type { SavedDesk } from "../desk/store";

/** A share is under way: being made, live, or being ended. */
export function liveActive(state: LiveShareState): boolean {
  return state.status === "starting" || state.status === "live" || state.status === "ending";
}

/** The space shared (or being shared), while a share is starting or live. */
export function sharedSpace(state: LiveShareState): string | null {
  return state.status === "starting" || state.status === "live" ? state.groupId : null;
}

/**
 * What sharing `groupId` does now: it is shared already (or on its way) —
 * the card; otherwise a start, which first stops the share of another space
 * (`replaces`, for the person to agree to: one live share per Mac).
 */
export type ShareAction = { kind: "open" } | { kind: "start"; replaces: string | null };

export function shareActionFor(state: LiveShareState, groupId: string): ShareAction {
  if (sharedSpace(state) === groupId) return { kind: "open" };
  const other = sharedSpace(state);
  return { kind: "start", replaces: other };
}

/** A space's live entries on its menu, in order. */
export type SpaceLiveEntry = "share" | "card" | "stop";

export function spaceLiveEntries(state: LiveShareState, groupId: string): SpaceLiveEntry[] {
  return sharedSpace(state) === groupId ? ["card", "stop"] : ["share"];
}

/** What `/draw` does: draw (or stop drawing) over the shared desk, or say why it cannot. */
export type DrawAction = { kind: "draw"; drawing: LiveDrawing | null } | { kind: "explain"; message: string };

export function drawActionFor(state: LiveShareState, currentGroupId: string | null, pen: LiveDrawing, sharedName: string): DrawAction {
  if (state.status !== "live") return { kind: "explain", message: "Drawing is for a live share: /share this space first" };
  if (state.drawing !== null) return { kind: "draw", drawing: null };
  // Pointers and ink belong to the shared desk: on another space they would be drawn over nothing guests see.
  if (state.groupId !== currentGroupId) return { kind: "explain", message: `You draw over the shared space: go back to ${sharedName} first` };
  return { kind: "draw", drawing: pen };
}

/**
 * Whether guests can be let use a window: a tab's page, or a terminal —
 * whose keys main hands the shell's terminal as typed (§6.6) — but no other
 * window the shell draws (home, notes, a brief: guests watch it, cut from the
 * shell's own picture, and no hands reach it) nor a masked one (its capture
 * would be its whole page, what the mask cuts away included: it is its frame
 * alone to guests, not streamed, §3). A window is masked as the desk saved
 * it (`saved`: its space's arrangement, kept as it changes).
 */
export function guestsCanBeLetUse(tab: { id: string; url: string }, saved: SavedDesk | undefined): boolean {
  return (!isShellPageUrl(tab.url) || isTerminalUrl(tab.url)) && saved?.windows.some((window) => window.tabId === tab.id && window.mask !== undefined) !== true;
}

/** Why a window cannot be handed to guests, as its row in the Live card says: they watch a window the shell draws; a masked one they do not see. */
export function notUsableReason(tab: { url: string }): string {
  return isShellPageUrl(tab.url) ? "Guests watch it; only you can use it" : "Only on your screen for now";
}

/**
 * Why guests cannot use, now, a window they may be let use: it does not
 * stream — minimized, or under the eight windows that do (§3) — and a
 * guest's hands reach only a window whose picture they have. Null while it
 * streams. The host may still let them: it holds once the window streams.
 */
export function notStreamingReason(state: LiveShareState, windowId: string): string | null {
  return state.streamed.includes(windowId) ? null : "Not streamed now: guests see its frame alone";
}

/**
 * A window's *Guests can use this window*: offered while its space is
 * shared live and the window is one of it guests can be let use (a tab's own
 * page or a terminal, streamed — guests' hands reach only what they see),
 * checked while guests may use it. One that does not stream now is offered
 * only to take back (the card says why it is not theirs to use).
 */
export function guestUseEntry(state: LiveShareState, groupId: string | null, windowId: string, usable: boolean): { checked: boolean } | null {
  if (state.status !== "live" || groupId === null || state.groupId !== groupId || !usable) return null;
  const checked = state.controllable.includes(windowId);
  return checked || state.streamed.includes(windowId) ? { checked } : null;
}

/** What the Live card shows: the share as main has it — or, a start asked for that main has not taken up yet, starting. */
export type LiveCardStatus = "starting" | "live" | "ending" | "error" | "idle";

export function liveCardStatus(state: LiveShareState, requested: { groupId: string } | null): LiveCardStatus {
  if (requested !== null && !(state.groupId === requested.groupId && state.status !== "idle")) return "starting";
  return state.status;
}

/** How long the share has been live: "0:42", "12:04", "1:02:03". */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}` : `${String(minutes)}:${seconds}`;
}

/** The name guests see the host by, read off the Mac's own name (main reads it when this finds none). */
export { hostNameFrom } from "@pistachio/live-share";

/** The link as the card shows it: no scheme, the token cut to its head (the whole link is what Copy copies). */
export function linkLabel(link: string): string {
  const bare = link.replace(/^https?:\/\//, "");
  const slash = bare.lastIndexOf("/");
  if (slash < 0) return bare;
  const token = bare.slice(slash + 1);
  return token.length > 12 ? `${bare.slice(0, slash + 1)}${token.slice(0, 10)}…` : bare;
}
