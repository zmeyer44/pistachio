/**
 * Away spaces as an extension reaches them (docs/primitives.md §2;
 * docs/extensions.md §5 `spaces`): the away service through the scope's
 * eyes, the grant that says WHICH spaces an extension may send away, and
 * what happens to the spaces it holds when it is gone. Pure, so the scope,
 * the service and the tests share it.
 *
 * The grant is object-scoped: `spaces:write` on the sheet lets an extension
 * send spaces away at all; a space is its to send only once the person ran
 * one of its commands IN that space — a Bar command, a menu item, a key, its
 * icon. That gesture is remembered on its record (`ExtensionRecord.spaces`),
 * not for the moment as a tab's is: a schedule acts on the space long after
 * the gesture, with nobody's hand on it.
 */

import { AWAY_REFUSALS, type AwayHolder, type AwayOutcome, type AwayRefusal, type AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import { ExtError, type ExtAwaySpace, type ExtErrorCode } from "@pistachio/extension-api";
import { CLOSE_REFUSALS, type CloseOutcome, type CloseRefusal } from "../space-closing";

/** Main's away spaces (main/away-spaces.ts AwaySpaces), as much of them as extensions reach. */
export interface ExtensionAwayHost {
  send(groupId: string, options: { by: AwayHolder; until?: number; unattended?: boolean; absent?: boolean }): Promise<AwayOutcome>;
  bringBack(id: string, options?: { select?: boolean; by?: AwayHolder }): Promise<AwayOutcome>;
  all(): AwaySpaceInfo[];
  get(id: string): AwaySpaceInfo | null;
  /** Whether a tab is away now, with whichever space holds it (AwaySpaces.holdsTab). */
  holdsTab?(tabId: string): boolean;
  /** Whether a space is on its way out or back this moment (AwaySpaces.moving): its tabs moved, they were not closed or opened. */
  moving?(id: string): boolean;
  /** How many times a space has gone or come back so far (AwaySpaces.moves), and whether one did after a count read earlier. */
  moves?(): number;
  movedSince?(id: string, moves: number): boolean;
  onChange(listener: (change: { event: "sent" | "returned"; space: AwaySpaceInfo }) => void): () => void;
}

/** Main's verb for closing a space into the archive (main/space-closing.ts SpaceClosing), as much of it as extensions reach. */
export interface ExtensionClosingHost {
  close(groupId: string, options: { by: AwayHolder; unattended?: boolean; absent?: boolean }): Promise<CloseOutcome>;
  /** Take a close back: the archive's entry restored as the space it was, not in front. */
  reopen(entryId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Whether the archive still holds that entry (not restored, removed or lapsed since). */
  filed?(entryId: string): boolean;
}

const CLOSE_CODES: Record<CloseRefusal, ExtErrorCode> = {
  unknown: "NOT_FOUND",
  notASpace: "INVALID_ARGUMENT",
  live: "UNAVAILABLE",
  sharing: "UNAVAILABLE",
  recording: "UNAVAILABLE",
  working: "UNAVAILABLE",
  tooMany: "UNAVAILABLE",
  unkept: "UNAVAILABLE",
  inFront: "UNAVAILABLE",
  playing: "UNAVAILABLE",
  terminal: "UNAVAILABLE",
  failed: "UNAVAILABLE",
};

const CLOSE_FIXES: Partial<Record<CloseRefusal, string>> = {
  unknown: "spaces.list() shows the spaces that are here; one that is away is brought back first",
  notASpace: "close a space from spaces.list() that is neither a Home tab's nor a favorite's page's",
  live: "try again later; nothing was changed",
  sharing: "try again later; nothing was changed",
  recording: "try again later; nothing was changed",
  working: "try again later; nothing was changed",
  tooMany: "nothing was changed, and trying again changes nothing until the person has closed tabs in that space: tell them, with ui.toast or a row",
  unkept: "nothing was changed, and trying again changes nothing until the person has closed that tab (a blank page, or one whose address is too long to keep): tell them, with ui.toast or a row",
  // (Thrown from a trigger's handler, these are tried again by Pistachio itself: let the error out of the handler.)
  inFront: "let the handler fail: Pistachio runs the trigger again later, when the person has moved on",
  playing: "let the handler fail: Pistachio runs the trigger again later",
  terminal: "let the handler fail: Pistachio runs the trigger again later",
};

/** A refusal of the closing verb as the wire says it: its code, the verb's own sentence, and the fix. */
export function closeError(method: string, refusal: CloseRefusal): ExtError {
  const fix = CLOSE_FIXES[refusal];
  return new ExtError(CLOSE_CODES[refusal], `${method}: ${CLOSE_REFUSALS[refusal]}${fix === undefined ? "" : ` (${fix})`}`);
}

/** The spaces one extension may hold a grant for: the newest kept. */
export const MAX_SPACE_GRANTS = 50;

const SPACE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/i;

/** `ExtensionRecord.spaces` read back: space ids, each once, the newest MAX_SPACE_GRANTS. */
export function sanitizeSpaceGrants(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.filter((id): id is string => typeof id === "string" && SPACE_ID.test(id)))];
  return ids.slice(Math.max(0, ids.length - MAX_SPACE_GRANTS));
}

/** The grants with `spaceId` among them, newest last; the same list when it is there already. */
export function withSpaceGrant(spaces: readonly string[], spaceId: string): string[] {
  if (spaces.includes(spaceId) || !SPACE_ID.test(spaceId)) return [...spaces];
  return sanitizeSpaceGrants([...spaces, spaceId]);
}

/** What a call without the grant is told — in words an agent writing the extension can act on. */
export function spaceNotGranted(method: string, spaceId: string): ExtError {
  return new ExtError(
    "PERMISSION_DENIED",
    `${method}: the person has not given this extension the space ${spaceId}. A space is the extension's — to send away, to mark, to give a backdrop or rows of its own — once the person runs one of its commands IN that space: a Bar command (pistachio.json → bar), an item in the space's own menu (contextMenus with the "space" context), a key, or its icon. The handler's ctx.spaceId (a menu item's info.spaceId) is that space: pass it, and keep it in storage for later`,
  );
}

const CODES: Record<AwayRefusal, ExtErrorCode> = {
  unknown: "NOT_FOUND",
  notAway: "NOT_FOUND",
  notASpace: "INVALID_ARGUMENT",
  past: "INVALID_ARGUMENT",
  live: "UNAVAILABLE",
  sharing: "UNAVAILABLE",
  recording: "UNAVAILABLE",
  working: "UNAVAILABLE",
  full: "UNAVAILABLE",
  tooMany: "UNAVAILABLE",
  unkept: "UNAVAILABLE",
  room: "UNAVAILABLE",
  tabsFull: "UNAVAILABLE",
  failed: "UNAVAILABLE",
  inFront: "UNAVAILABLE",
  playing: "UNAVAILABLE",
  terminal: "UNAVAILABLE",
};

/** What the author can do about a refusal, where there is something; the service's own sentence already says what the person can. */
const FIXES: Partial<Record<AwayRefusal, string>> = {
  unknown: "spaces.list() shows the spaces that are here, spaces.away() the ones already away",
  notAway: "spaces.away() lists the spaces that are away; one already back needs nothing",
  notASpace: "send away a space from spaces.list() that the person made — ctx.spaceId of a command run in it",
  past: "pass a time after Date.now(), in ms, as a Date or as an ISO string with its offset",
  live: "try again later; nothing was changed",
  sharing: "try again later; nothing was changed",
  recording: "try again later; nothing was changed",
  working: "try again later; nothing was changed",
  tooMany: "nothing was changed, and trying again changes nothing until the person has closed tabs in that space: tell them, with ui.toast or a row",
  unkept: "nothing was changed, and trying again changes nothing until the person has closed that tab (a blank page, or one whose address is too long to keep): tell them, with ui.toast or a row",
  tabsFull: "the space is still away, whole; it can come back once the person has closed tabs in that Profile — one with a time set is brought back by Pistachio then",
  // (Thrown from a trigger's handler, these are tried again by Pistachio itself: let the error out of the handler.)
  inFront: "let the handler fail: Pistachio runs the trigger again later, when the person has moved on",
  playing: "let the handler fail: Pistachio runs the trigger again later",
  terminal: "let the handler fail: Pistachio runs the trigger again later",
};

/** A refusal of the away service as the wire says it: its code, the service's sentence, and the fix. */
export function awayError(method: string, refusal: AwayRefusal): ExtError {
  const fix = FIXES[refusal];
  return new ExtError(CODES[refusal], `${method}: ${AWAY_REFUSALS[refusal]}${fix === undefined ? "" : ` (${fix})`}`);
}

/** An away space as an extension sees it. */
export function extAwaySpace(space: AwaySpaceInfo, extensionId: string): ExtAwaySpace {
  return {
    id: space.id,
    name: space.title,
    color: space.color ?? null,
    tabCount: space.tabCount,
    since: space.since,
    ...(space.until === undefined ? {} : { until: space.until }),
    mine: heldBy(space, extensionId),
  };
}

/** The extension sent it away. */
export function heldBy(space: Pick<AwaySpaceInfo, "by">, extensionId: string): boolean {
  return space.by.kind === "extension" && space.by.extensionId === extensionId;
}

/**
 * The away spaces nobody is left to bring back: sent by an extension that is
 * removed, turned off, or off in the space's Profile (`runs`: it is there
 * and on in that Profile). They come back (returnStranded) — a space is
 * never stranded behind an extension that is gone.
 */
export function strandedSpaces(all: readonly AwaySpaceInfo[], runs: (extensionId: string, profileId: string) => boolean): AwaySpaceInfo[] {
  return all.filter((space) => space.by.kind === "extension" && !runs(space.by.extensionId, space.spaceId));
}

/**
 * Whether a space just sent away arrived stranded: its sender is an extension that no longer runs in its Profile.
 * A send the service had accepted is not cancelled by the worker stopping, so one that waited its turn — or on the
 * desk passing on — while its extension was turned off or removed lands after the cleanup that would have caught
 * it. What lands is asked the same question.
 */
export function strandedOnSend(change: { event: "sent" | "returned"; space: AwaySpaceInfo }, runs: (extensionId: string, profileId: string) => boolean): boolean {
  return change.event === "sent" && strandedSpaces([change.space], runs).length > 0;
}

/** Bring every stranded space back, in front of nothing; answers the ids that came. One refused for want of room stays away, listed, a press from back. */
export async function returnStranded(away: Pick<ExtensionAwayHost, "all" | "bringBack">, runs: (extensionId: string, profileId: string) => boolean): Promise<string[]> {
  const back: string[] = [];
  for (const space of strandedSpaces(away.all(), runs)) {
    const outcome = await away.bringBack(space.id);
    if (outcome.ok) back.push(space.id);
  }
  return back;
}
