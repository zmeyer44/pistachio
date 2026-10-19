/**
 * The guest's way in (docs/live-share.md §1 The guest, §5 Guest routes): the
 * screens a link leads through and what moves between them, as a pure
 * reducer. The page runs the effects each screen calls for — fetch the
 * share, knock, poll every 1.5 s, join the room — and reports what came back
 * as events; nothing here touches the network or the DOM.
 *
 *   loading → lobby → knocking → joining → room → over
 *
 * `over` is every way out, with its reason: the share ended or was never
 * live, the host said no or removed them, they left, the same guest joined
 * from another tab, the connection could not be kept, or there was no room.
 */

import type { LiveEndReason } from "../room.js";

/** `GET /v1/live/join/:token`. */
export interface LiveJoinInfo {
  title: string;
  hostName: string | null;
  admission: "ask" | "open";
  status: "live" | "ended";
}

/** A request's status as control's poll reports it. */
export type LiveRequestStatus = "pending" | "admitted" | "denied" | "removed" | "left" | "ended";

/** The guest's own request, proven by its secret (kept per link for a reload, §5). */
export interface LiveGuestRequest {
  requestId: string;
  secret: string;
}

/** The room's address and a token for it, minted by control for an admitted guest. */
export interface LiveGuestTicket {
  url: string;
  token: string;
  identity: string;
  color: string;
}

export type GuestOverReason =
  /** The host stopped sharing. */
  | "ended"
  /** No such link (or it ended long ago). */
  | "not_found"
  | "denied"
  | "removed"
  | "left"
  /** This guest joined again somewhere else. */
  | "replaced"
  /** The room was joined and lost, or could not be joined. */
  | "lost"
  /** Live share or control could not be reached. */
  | "unavailable"
  /** Eight guests are in already. */
  | "full";

/** Why a knock did not go through, shown in the lobby: the person can try again from there. */
export type GuestLobbyError = "lobby_full" | "rate_limited" | "network" | "name";

export type GuestScreen =
  | { kind: "loading" }
  | { kind: "lobby"; share: LiveJoinInfo; busy: boolean; error: GuestLobbyError | null }
  | { kind: "knocking"; share: LiveJoinInfo; request: LiveGuestRequest }
  | { kind: "joining"; share: LiveJoinInfo; request: LiveGuestRequest; ticket: LiveGuestTicket }
  | { kind: "room"; share: LiveJoinInfo; request: LiveGuestRequest; ticket: LiveGuestTicket }
  | { kind: "over"; reason: GuestOverReason; share: LiveJoinInfo | null };

/** What a knock or a poll answered. */
export interface LiveRequestAnswer {
  status: LiveRequestStatus;
  ticket: LiveGuestTicket | null;
}

export type GuestEvent =
  /** The link's share, fetched as the page opens. */
  | { type: "loaded"; share: LiveJoinInfo }
  /** The link's share and, kept from before a reload, this guest's request as control sees it now. */
  | { type: "resumed"; share: LiveJoinInfo; request: LiveGuestRequest; answer: LiveRequestAnswer | null }
  | { type: "loadFailed"; reason: "not_found" | "unavailable" }
  | { type: "knock" }
  | { type: "knocked"; request: LiveGuestRequest; answer: LiveRequestAnswer }
  | { type: "knockFailed"; error: GuestLobbyError | "ended" | "not_found" | "full" | "unavailable" }
  | { type: "polled"; answer: LiveRequestAnswer }
  | { type: "cancel" }
  | { type: "connected" }
  | { type: "connectFailed" }
  | { type: "roomEnded"; reason: LiveEndReason }
  /** Leave the room (or a screen that offers to rejoin): back to the start. */
  | { type: "restart" };

export const INITIAL_GUEST_SCREEN: GuestScreen = { kind: "loading" };

const lobby = (share: LiveJoinInfo): GuestScreen => ({ kind: "lobby", share, busy: false, error: null });
const over = (reason: GuestOverReason, share: LiveJoinInfo | null): GuestScreen => ({ kind: "over", reason, share });

/** Where a request's status leads, from the lobby, the wait, or a reload. */
function answered(share: LiveJoinInfo, request: LiveGuestRequest, answer: LiveRequestAnswer): GuestScreen {
  switch (answer.status) {
    case "pending":
      return { kind: "knocking", share, request };
    case "admitted":
      // Admitted without a ticket cannot happen on the wire; waiting one more poll is the safe reading.
      return answer.ticket === null ? { kind: "knocking", share, request } : { kind: "joining", share, request, ticket: answer.ticket };
    case "denied":
      return over("denied", share);
    case "removed":
      return over("removed", share);
    case "ended":
      return over("ended", share);
    case "left":
      // Left (from another tab, or before a reload): this page starts afresh.
      return lobby(share);
  }
}

const END_REASONS: Readonly<Record<LiveEndReason, GuestOverReason>> = {
  left: "left",
  removed: "removed",
  ended: "ended",
  replaced: "replaced",
  failed: "lost",
};

export function guestFlow(screen: GuestScreen, event: GuestEvent): GuestScreen {
  switch (event.type) {
    case "loaded":
      if (screen.kind !== "loading") return screen;
      return event.share.status === "ended" ? over("ended", event.share) : lobby(event.share);
    case "resumed":
      if (screen.kind !== "loading") return screen;
      if (event.share.status === "ended") return over("ended", event.share);
      // A request control no longer knows (or could not say): start afresh.
      return event.answer === null ? lobby(event.share) : answered(event.share, event.request, event.answer);
    case "loadFailed":
      return screen.kind === "loading" ? over(event.reason, null) : screen;
    case "knock":
      return screen.kind === "lobby" ? { ...screen, busy: true, error: null } : screen;
    case "knocked":
      return screen.kind === "lobby" ? answered(screen.share, event.request, event.answer) : screen;
    case "knockFailed": {
      if (screen.kind !== "lobby") return screen;
      switch (event.error) {
        case "ended":
          return over("ended", screen.share);
        case "not_found":
          return over("not_found", screen.share);
        case "full":
          return over("full", screen.share);
        case "unavailable":
          return over("unavailable", screen.share);
        default:
          return { ...screen, busy: false, error: event.error };
      }
    }
    case "polled":
      return screen.kind === "knocking" ? answered(screen.share, screen.request, event.answer) : screen;
    case "cancel":
      return screen.kind === "knocking" ? lobby(screen.share) : screen;
    case "connected":
      return screen.kind === "joining" ? { ...screen, kind: "room" } : screen;
    case "connectFailed":
      return screen.kind === "joining" ? over("lost", screen.share) : screen;
    case "roomEnded":
      return screen.kind === "room" || screen.kind === "joining" ? over(END_REASONS[event.reason], screen.share) : screen;
    case "restart":
      return INITIAL_GUEST_SCREEN;
  }
}
