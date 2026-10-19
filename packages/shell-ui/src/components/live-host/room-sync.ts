/**
 * The room as the host tells it (docs/live-share.md §4, §6.3): the `lv.sync`
 * a guest is sent when they join or say `lv.hello`, and the guests main is
 * told about. Pure, so test/live-host-room.test.ts holds what goes out.
 *
 * Who owns what: main keeps the chat (it is in `LiveShareState.chat`, the
 * host's own messages and the guests' as main took them) and who uses which
 * window (`using`); the host app keeps the ink board, since it alone hears
 * every stroke. A sync is the three put together with the latest desk frame.
 */

import {
  LIVE_TOPICS,
  liveChatEntrySchema,
  liveDeskFrameSchema,
  MAX_CHAT_HISTORY,
  MAX_DESK_WINDOWS,
  MAX_STROKES,
  type LiveChatEntry,
  type LiveStroke,
  type LiveSync,
} from "@pistachio/live-share";
import type { LiveParticipant } from "@pistachio/live-share/room";
import type { LiveChatMessage, LiveGuest, LiveHostDeskFrame, LiveShareState, LiveWindowAsk, LiveWindowUse } from "@pistachio/shell-contracts/live-share";

export interface SyncInputs {
  frame: LiveHostDeskFrame | null;
  /** The board's strokes (`InkBoard.snapshot()`). */
  strokes: readonly LiveStroke[];
  chat: readonly LiveChatMessage[];
  using: readonly LiveWindowUse[];
}

/** The most of a sync a guest reads: `lv.sync`'s limit, in characters of its JSON (as a text stream is measured). */
export const SYNC_MAX_CHARS = LIVE_TOPICS["lv.sync"].maxBytes;

/**
 * The room for one guest. Whatever would break the protocol's schema is left
 * out rather than failing the whole sync: a desk frame that does not parse
 * goes as none (the next `lv.desk` brings it), a chat message that does not
 * is skipped. And it is cut to `maxChars` of JSON (`fitSync`): a guest
 * refuses a sync past what it reads, so while the board and the chat stayed
 * that large, whoever joined or came back would have neither.
 */
export function buildSync(inputs: SyncInputs, maxChars = SYNC_MAX_CHARS): LiveSync {
  const desk = inputs.frame === null ? null : liveDeskFrameSchema.safeParse(inputs.frame);
  const chat: LiveChatEntry[] = [];
  for (const message of inputs.chat.slice(-MAX_CHAT_HISTORY)) {
    const entry = liveChatEntrySchema.safeParse(message);
    if (entry.success) chat.push(entry.data);
  }
  // One grant per window, the latest.
  const grants = new Map<string, string>();
  for (const use of inputs.using) grants.set(use.windowId, use.identity);
  return fitSync(
    {
      desk: desk?.success === true ? desk.data : null,
      strokes: inputs.strokes.slice(-MAX_STROKES),
      chat,
      grants: [...grants].slice(-MAX_DESK_WINDOWS).map(([w, user]) => ({ w, user })),
    },
    maxChars,
  );
}

const jsonLength = (value: unknown): number => JSON.stringify(value).length;

/**
 * `sync` within `maxChars` of JSON: past it, the oldest strokes go first,
 * then the oldest chat, then the desk (the next `lv.desk` brings it); what
 * is left, who uses which window (64 at most), is tens of KB at most. A
 * board on the ink's grid with the chat at its longest fits as it is, so in
 * practice only a desk of unusual size costs the oldest strokes. The sync is
 * measured once and only what goes is measured again, not once a stroke.
 */
function fitSync(sync: LiveSync, maxChars: number): LiveSync {
  let over = jsonLength(sync) - maxChars;
  if (over <= 0) return sync;
  const strokes = dropOldest(sync.strokes, over);
  over -= strokes.saved;
  const chat = dropOldest(sync.chat, over);
  over -= chat.saved;
  return { ...sync, desk: over > 0 ? null : sync.desk, strokes: strokes.kept, chat: chat.kept };
}

/** `items` without as many of the first as it takes to save `over` characters of their JSON array, and what that saved. */
function dropOldest<T>(items: readonly T[], over: number): { kept: T[]; saved: number } {
  let saved = 0;
  let dropped = 0;
  while (saved < over && dropped < items.length) {
    // An item and the comma after it (the last one has none).
    saved += jsonLength(items[dropped]) + (dropped < items.length - 1 ? 1 : 0);
    dropped += 1;
  }
  return { kept: items.slice(dropped), saved };
}

/** The guests in the room as main hears of them: everyone but the host, in join order. */
export function guestsOf(participants: readonly LiveParticipant[]): LiveGuest[] {
  return participants
    .filter((participant) => !participant.isLocal && participant.role === "guest")
    .map((participant) => ({
      identity: participant.identity,
      name: participant.name,
      color: participant.color,
      micOn: participant.micOn,
      cameraOn: participant.cameraOn,
      speaking: participant.speaking,
      connection: participant.connection,
    }));
}

/** Whether two rosters say the same: main is told only when it changed (a level's tick is not a change). */
export function sameGuests(a: readonly LiveGuest[], b: readonly LiveGuest[]): boolean {
  return (
    a.length === b.length &&
    a.every((guest, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        guest.identity === other.identity &&
        guest.name === other.name &&
        guest.color === other.color &&
        guest.micOn === other.micOn &&
        guest.cameraOn === other.cameraOn &&
        guest.speaking === other.speaking &&
        guest.connection === other.connection
      );
    })
  );
}

/**
 * The asks the host said no to between two states of the share: an ask that
 * left main's list while its guest is still in the room and the window is
 * still not theirs to use. (Main takes an ask away when the host answers it
 * — allowed, the window becomes usable — or when its guest leaves.)
 */
export function refusedAsks(before: LiveShareState, after: LiveShareState): LiveWindowAsk[] {
  return before.asks.filter(
    (ask) =>
      !after.asks.some((next) => next.identity === ask.identity && next.windowId === ask.windowId) &&
      after.participants.some((guest) => guest.identity === ask.identity) &&
      !after.controllable.includes(ask.windowId),
  );
}

/** Each guest's presence in the room (LiveKit's sid), by identity. */
export function sessionsOf(participants: readonly LiveParticipant[]): Map<string, string> {
  return new Map(participants.filter((participant) => !participant.isLocal && participant.role === "guest").map((participant) => [participant.identity, participant.sid]));
}

/**
 * The guests back under the same identity with a new presence (sid): a
 * reload, or a removed guest's refreshed token, that came before the room
 * said they left — LiveKit's client never says they went or came, and the
 * roster reads the same.
 */
export function cameBack(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...after].filter(([identity, sid]) => before.has(identity) && before.get(identity) !== sid).map(([identity]) => identity);
}

/** Who came and who went between two rosters. */
export function rosterChange(before: readonly LiveGuest[], after: readonly LiveGuest[]): { joined: string[]; left: string[] } {
  const was = new Set(before.map((guest) => guest.identity));
  const is = new Set(after.map((guest) => guest.identity));
  return {
    joined: [...is].filter((identity) => !was.has(identity)),
    left: [...was].filter((identity) => !is.has(identity)),
  };
}
