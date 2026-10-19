/**
 * A participant's copy of the room's chat (docs/live-share.md §4 Chat). Live
 * messages are appended as they arrive; a sync brings the host's history,
 * which goes first, and anything this side already had that the sync lacks
 * (sent or received after the host took it) follows in the order it came.
 * Merged by sender and id (`chatKey`), so a message the sync and the room both
 * delivered shows once. Never by id alone: each sender picks its own ids and
 * only the sender is vouched for (by the room, or by the host in a sync), so a
 * guest sending another's id first would hide that message.
 * Order is by arrival, never by `at`: the host's clock and a guest's differ.
 */

import { MAX_CHAT_HISTORY, type LiveChatEntry } from "../protocol.js";

/** What a participant keeps: the host keeps 200, a guest a little more of its own session. */
export const CHAT_KEEP = MAX_CHAT_HISTORY * 2;

/** One message among the room's: its sender and the id they gave it (identities and ids never hold a NUL). */
export function chatKey(message: Pick<LiveChatEntry, "from" | "id">): string {
  return `${message.from}\u0000${message.id}`;
}

/** `log` with `entry` appended, unless its sender's message of that id is there already. */
export function appendChat(log: readonly LiveChatEntry[], entry: LiveChatEntry): readonly LiveChatEntry[] {
  if (log.some((existing) => existing.from === entry.from && existing.id === entry.id)) return log;
  const next = [...log, entry];
  return next.length > CHAT_KEEP ? next.slice(next.length - CHAT_KEEP) : next;
}

/** A sync's history merged into `log`. */
export function mergeChat(log: readonly LiveChatEntry[], history: readonly LiveChatEntry[]): readonly LiveChatEntry[] {
  const seen = new Set<string>();
  const next: LiveChatEntry[] = [];
  for (const entry of [...history, ...log]) {
    const key = chatKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(entry);
  }
  return next.length > CHAT_KEEP ? next.slice(next.length - CHAT_KEEP) : next;
}

let chatCounter = 0;

/** A fresh id for a message this participant sends: `<identity>:<time>-<n>`, unique across a reload. */
export function newChatId(identity: string, now: number = Date.now()): string {
  chatCounter = (chatCounter + 1) % 1_000_000;
  return `${identity}:${now.toString(36)}-${chatCounter.toString(36)}`.slice(0, 64);
}
