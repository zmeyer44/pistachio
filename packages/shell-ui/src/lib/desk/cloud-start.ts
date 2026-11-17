/**
 * A cloud conversation being started from a space's Bar (docs/desk-agent.md
 * §1, "The chat is its space's").
 *
 * The start is a request to control, and takes its time; the person may be
 * in another space when it answers. The Bar's composer is made anew for
 * each space (DeskBar keys it), so the one that asked may be gone by then,
 * and what the Bar shares between spaces — the files staged, the card — is
 * the next space's. How the start went is the asking space's all the same:
 * heard by whichever composer of that space is up when it answers (the one
 * that asked, or the one made when the person came back), and with none up,
 * kept for it — a start that was taken empties the field and the staged
 * files the space was left with (lib/desk/space-chat.ts), and a refusal
 * leaves them, to be sent again.
 */

import type { ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { keepSpaceChat } from "./space-chat";

/**
 * Where a cloud conversation asked for now is to run: the Profile in view
 * and the address of the tab in use, read as the person presses send. Main
 * takes the active ones when a request names none — and by the time the
 * request is made (a file the message mentions is read first) the person
 * may be in another Profile, on another page. An empty address is still the
 * request's own word: no page to start from, not "whichever is in view".
 */
export function cloudStartContext(snapshot: Pick<ShellSnapshot, "activeSpaceId" | "activeTabId" | "tabs"> | null): { spaceId?: string; startUrl: string } {
  if (snapshot === null) return { startUrl: "" };
  return { spaceId: snapshot.activeSpaceId, startUrl: snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.url ?? "" };
}

/** How a start went, as the store answers it. */
export type CloudStart = { ok: true } | { ok: false; error: string };

const starting = new Set<string>();
const hearers = new Map<string, (result: CloudStart) => void>();
/** Starts control has taken, whose conversation is yet to reach its space: each one's patience (`CLOUD_ARRIVAL_MS`). */
const awaited = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How long a start that control has taken stays under way with no word of
 * its conversation. The conversation reaches the space with its first event
 * (main's RunHub.cloudStarted), a moment after control's answer — and until
 * it has, the space still shows none, so a message sent then would start a
 * second cloud conversation instead of continuing the first. One that never
 * comes (the stream failed) must not hold the Bar for good.
 */
export const CLOUD_ARRIVAL_MS = 30_000;

const watchers = new Set<() => void>();

function changed(): void {
  for (const watcher of [...watchers]) watcher();
}

/** Told whenever a start begins or is over, in any space (a composer redraws what it offers meanwhile). */
export function watchCloudStarts(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/**
 * A start asked from this space's Bar is under way: unanswered by control,
 * or taken with its conversation yet to reach the space. Nothing more is
 * sent from the space meanwhile, to the cloud or to this Mac — the same
 * words sent on would run twice — and where the next conversation runs is
 * not to be changed.
 */
export function cloudStarting(groupId: string): boolean {
  return starting.has(groupId);
}

/** A start is under way from this space; false when one already was — a second Enter starts no second conversation. */
export function beginCloudStart(groupId: string): boolean {
  if (starting.has(groupId)) return false;
  starting.add(groupId);
  changed();
  return true;
}

/** This space's composer is up, and hears how its space's start went; returns the way to stop hearing. */
export function hearCloudStart(groupId: string, hear: (result: CloudStart) => void): () => void {
  hearers.set(groupId, hear);
  return () => {
    if (hearers.get(groupId) === hear) hearers.delete(groupId);
  };
}

/**
 * The start asked from a space was answered. Its composer hears, when one is
 * up. With the person in another space: taken, the space's kept field and
 * staged files are emptied for when they are back; refused, they stay, and
 * `elsewhere` says so where the person is (the banner is the field's own).
 */
export function settleCloudStart(groupId: string, result: CloudStart, elsewhere: (error: string) => void): void {
  // Refused, it is over. Taken, it is under way until its conversation is in the space (`cloudStartArrived`).
  if (result.ok) {
    clearTimeout(awaited.get(groupId));
    awaited.set(
      groupId,
      setTimeout(() => cloudStartArrived(groupId), CLOUD_ARRIVAL_MS),
    );
  } else {
    cloudStartArrived(groupId);
  }
  changed();
  const hear = hearers.get(groupId);
  if (hear !== undefined) {
    hear(result);
    return;
  }
  if (result.ok) keepSpaceChat(groupId, { draft: "", staged: [] });
  else elsewhere(result.error);
}

/** Control has taken this space's start, and its conversation is yet to reach the space. */
export function cloudStartTaken(groupId: string): boolean {
  return awaited.has(groupId);
}

/** The space's conversation is there (or its start was given up on): the next message is a message, and a new start may be made. */
export function cloudStartArrived(groupId: string): void {
  clearTimeout(awaited.get(groupId));
  const was = awaited.delete(groupId);
  if (starting.delete(groupId) || was) changed();
}

/** For tests: no start under way, nobody hearing. */
export function resetCloudStarts(): void {
  for (const timer of awaited.values()) clearTimeout(timer);
  awaited.clear();
  starting.clear();
  hearers.clear();
  watchers.clear();
}
