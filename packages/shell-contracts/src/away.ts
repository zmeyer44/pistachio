/**
 * Spaces that are away (docs/primitives.md §2): a space (tab group) sent off
 * the rail whole — its tabs asleep, nothing of it loaded — and kept exactly
 * as it was, to come back as itself: the same id (so its Stack and its
 * conversation are there), the same tabs under the same ids, their history
 * and their links to favorites. Not the archive, which is a place things are
 * filed to lapse: an away space is never pruned, says who sent it and when it
 * is due back, and one press brings it back.
 *
 * Main keeps them in a file of their own (main/away-store.ts), each as the
 * slice of the session it was (`held`: a DurableSpaceSession of that one
 * space), so what a restart keeps of a tab is what a space keeps while away,
 * and a field added to the session is carried here without a second list.
 */

import { MAX_ARCHIVED_GROUP_TABS } from "./tab-archive.js";
import { MAX_RESTORED_TABS_PER_SPACE, sanitizeTabSession, TAB_SESSION_VERSION, type DurableSpaceSession } from "./tab-session.js";
import { isTabGroupId, type TabGroupColor, type TabGroupInfo } from "./tab-groups.js";

export const AWAY_FILE_VERSION = 1;
/** Away spaces a Profile (Space) may hold: a bound, like the rail's, so the file is never without one. */
export const MAX_AWAY_SPACES_PER_PROFILE = 50;
/**
 * The most tabs a space may have and go away — or be closed by anyone but the person: what is read back of one
 * space, from the away file as from the session (MAX_RESTORED_TABS_PER_SPACE) and from the archive
 * (MAX_ARCHIVED_GROUP_TABS). One tab more would be dropped as the space was filed, and be in neither.
 */
export const MAX_TABS_KEPT_OF_A_SPACE = Math.min(MAX_RESTORED_TABS_PER_SPACE, MAX_ARCHIVED_GROUP_TABS);
/** The favicons an away space's row shows, as a rail tile's cluster does. */
export const AWAY_FAVICONS = 4;

/**
 * Who sent a space away — drawn by the shell beside it, in the shell's own
 * words, never the sender's: the person (its menu), the agent (a tool call
 * in a turn the person asked for), or an extension, by its name on the
 * approval sheet.
 */
export type AwayHolder = { kind: "person" } | { kind: "agent" } | { kind: "extension"; extensionId: string; name: string };

export interface AwaySpace {
  /** The space's id (TabGroupInfo.id), which it comes back under. */
  id: string;
  /** Its Profile (Space). */
  spaceId: string;
  by: AwayHolder;
  since: number;
  /** The instant main brings it back by itself (at it, or at the first tick after: launch, wake, unlock). Absent: until someone asks. */
  until?: number;
  /** The space and its tabs as the session held them: `tabGroups` is that one space, `tabs` its tabs in its order. */
  held: DurableSpaceSession;
}

export interface AwayFile {
  version: typeof AWAY_FILE_VERSION;
  spaces: AwaySpace[];
}

export const EMPTY_AWAY_FILE: AwayFile = { version: AWAY_FILE_VERSION, spaces: [] };

/** An away space as the snapshot lists it (ShellSnapshot.awaySpaces): what a row needs, nothing of its pages. */
export interface AwaySpaceInfo {
  id: string;
  spaceId: string;
  title: string;
  color: TabGroupColor;
  tabCount: number;
  /** Its first tabs' favicons (AWAY_FAVICONS at most), null where a tab has none. */
  favicons: (string | null)[];
  by: AwayHolder;
  since: number;
  until?: number;
  /** Due back, and kept waiting: its Profile has no room for another space (MAX_TAB_GROUPS_PER_SPACE). */
  waiting?: "room";
}

/** Why a space was not sent away, or did not come back — a sentence the shell, the agent and an extension's error all show as it is. */
export const AWAY_REFUSALS = {
  unknown: "That space is not here.",
  notASpace: "Only a space can be sent away: a Home tab or a favorite's page is not one.",
  live: "This space is being shared live. End the share, then send it away.",
  sharing: "A page in this space is sharing the screen. End the share, then send it away.",
  recording: "A page in this space is being recorded. Stop the recording, then send it away.",
  working: "Pistachio is working in this space. Wait for it to finish, then send it away.",
  failed: "That space could not be sent away. It is still here.",
  full: "There are as many spaces away as there may be. Bring one back first.",
  tooMany: "That space has more tabs than can be kept away. Close some, then send it away.",
  unkept: "A page in that space cannot be kept while it is away. Close that tab, then send the space away.",
  past: "The time to come back has passed already.",
  notAway: "That space is not away.",
  room: "There is no room for another space here. Close one, then bring this back.",
  tabsFull: "There are too many tabs open here for that space to come back. Close some, then bring it back.",
  // What only code running with nobody there is refused (docs/primitives.md §3): the person's own Send away is theirs to make.
  inFront: "That space is in front. It can go once another is.",
  playing: "Something is playing in that space.",
  terminal: "A terminal is open in that space, and sending the space away would end it.",
} as const;

export type AwayRefusal = keyof typeof AWAY_REFUSALS;

export type AwayOutcome = { ok: true; space: AwaySpaceInfo } | { ok: false; refusal: AwayRefusal; reason: string };

export function awayRefused(refusal: AwayRefusal): { ok: false; refusal: AwayRefusal; reason: string } {
  return { ok: false, refusal, reason: AWAY_REFUSALS[refusal] };
}

/**
 * A send refused for a tab that would not be kept (`unkept`), naming the tab when it has a name: a page no relaunch
 * reopens — an address longer than the session keeps, a blank page, a `blob:` one — would be dropped as the away
 * file is read back, its page already closed.
 */
export function awayUnkeptRefusal(title: string): { ok: false; refusal: AwayRefusal; reason: string } {
  const name = title.trim().slice(0, 80);
  return name === "" ? awayRefused("unkept") : { ok: false, refusal: "unkept", reason: `“${name}” cannot be kept while its space is away. Close that tab, then send the space away.` };
}

/** The first of `taken`'s tabs that `kept` — the same space as the file reads it back (heldSpace) — does not hold; null when it holds them all. */
export function firstUnkept(taken: DurableSpaceSession, kept: DurableSpaceSession | null): { id: string; title: string } | null {
  const ids = new Set(kept?.tabs.map((tab) => tab.id) ?? []);
  const lost = taken.tabs.find((tab) => !ids.has(tab.id));
  return lost === undefined ? null : { id: lost.id, title: lost.title };
}

function isHolder(value: unknown): value is AwayHolder {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (raw["kind"] === "person" || raw["kind"] === "agent") return true;
  return (
    raw["kind"] === "extension" &&
    typeof raw["extensionId"] === "string" &&
    raw["extensionId"].length > 0 &&
    raw["extensionId"].length <= 200 &&
    typeof raw["name"] === "string" &&
    raw["name"].length <= 80
  );
}

function holderOf(value: AwayHolder): AwayHolder {
  return value.kind === "extension" ? { kind: "extension", extensionId: value.extensionId, name: value.name } : { kind: value.kind };
}

/** An instant a file or a request may name: a finite time after 1970, in ms. */
export function isAwayInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 8.64e15;
}

/**
 * The file read back: each entry's `held` goes through the session's own
 * reading (this Mac's file: its local files and extension pages kept), and
 * an entry is kept only if what is left is one drawn space — never a Home
 * tab's or a page's, which cannot be away — under the entry's id. One entry
 * per space; a Profile's past the bound are dropped, newest kept.
 */
export function sanitizeAwayFile(value: unknown, validSpaceIds?: ReadonlySet<string>): AwayFile {
  if (typeof value !== "object" || value === null) return structuredClone(EMPTY_AWAY_FILE);
  const root = value as Record<string, unknown>;
  if (root["version"] !== AWAY_FILE_VERSION || !Array.isArray(root["spaces"])) return structuredClone(EMPTY_AWAY_FILE);
  const spaces: AwaySpace[] = [];
  const seen = new Set<string>();
  const perProfile = new Map<string, number>();
  // (Two sent in the same millisecond keep the order they were filed in: the later in the file is the newer.)
  const newestFirst = (root["spaces"] as unknown[])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (isAwayInstant(b.entry["since"]) ? b.entry["since"] : 0) - (isAwayInstant(a.entry["since"]) ? a.entry["since"] : 0) || b.index - a.index)
    .map(({ entry }) => entry);
  for (const raw of newestFirst) {
    const id = raw["id"];
    const spaceId = raw["spaceId"];
    if (!isTabGroupId(id) || seen.has(id) || typeof spaceId !== "string" || !isHolder(raw["by"]) || !isAwayInstant(raw["since"])) continue;
    if (validSpaceIds !== undefined && !validSpaceIds.has(spaceId)) continue;
    const held = heldSpace(raw["held"], spaceId, id);
    if (held === null) continue;
    const count = perProfile.get(spaceId) ?? 0;
    if (count >= MAX_AWAY_SPACES_PER_PROFILE) continue;
    perProfile.set(spaceId, count + 1);
    seen.add(id);
    spaces.push({ id, spaceId, by: holderOf(raw["by"]), since: raw["since"], ...(isAwayInstant(raw["until"]) ? { until: raw["until"] } : {}), held });
  }
  // Oldest first, as they were sent: the order the shell lists them in.
  spaces.reverse();
  return { version: AWAY_FILE_VERSION, spaces };
}

/** `held` as the session reads it, or null unless it is exactly the one drawn space `id`. */
export function heldSpace(value: unknown, spaceId: string, id: string): DurableSpaceSession | null {
  const session = sanitizeTabSession({ version: TAB_SESSION_VERSION, spaces: { [spaceId]: value } }, new Set([spaceId]), { files: true }).spaces[spaceId];
  const group = session?.tabGroups?.[0];
  if (session === undefined || group === undefined || session.tabGroups?.length !== 1) return null;
  if (group.id !== id || group.loose === true || group.anchorId !== undefined) return null;
  // Its tabs alone, in its order: a tab the space does not hold is not the space's to bring back.
  const members = new Set(group.tabIds);
  const tabs = session.tabs.filter((tab) => members.has(tab.id));
  const ids = new Set(tabs.map((tab) => tab.id));
  return {
    tabs,
    activeTabId: session.activeTabId !== null && ids.has(session.activeTabId) ? session.activeTabId : (tabs[0]?.id ?? null),
    recentTabIds: session.recentTabIds.filter((tabId) => ids.has(tabId)),
    splitGroups: [],
    tabGroups: [{ ...group, tabIds: group.tabIds.filter((tabId) => ids.has(tabId)) }],
  };
}

/** The space an entry holds. */
export function awayGroupOf(space: AwaySpace): TabGroupInfo {
  return space.held.tabGroups![0]!;
}

/** What the snapshot says of an away space. */
export function awaySpaceInfo(space: AwaySpace, waiting?: "room"): AwaySpaceInfo {
  const group = awayGroupOf(space);
  const byId = new Map(space.held.tabs.map((tab) => [tab.id, tab]));
  return {
    id: space.id,
    spaceId: space.spaceId,
    title: group.title,
    color: group.color,
    tabCount: group.tabIds.length,
    favicons: group.tabIds.slice(0, AWAY_FAVICONS).map((tabId) => byId.get(tabId)?.faviconUrl ?? null),
    by: holderOf(space.by),
    since: space.since,
    ...(space.until === undefined ? {} : { until: space.until }),
    ...(waiting === undefined ? {} : { waiting }),
  };
}

/** Who sent it away, in the shell's words: nothing for the person (it was their own press), "Pistachio" for the agent, an extension's name. */
export function awayHolderName(by: AwayHolder): string | null {
  if (by.kind === "person") return null;
  return by.kind === "agent" ? "Pistachio" : by.name;
}

/**
 * When an away space is due back, as a row and a notice say it: "today
 * 8:00 PM", "tomorrow 8:00 AM", within a week the day ("Sun 8:00 AM"), past
 * that the date ("Nov 29, 8:00 AM"). In this Mac's zone and manner unless
 * told (tests name both).
 */
export function formatReturn(until: number, now: number, options: { timeZone?: string; locale?: string } = {}): string {
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  // (Plain spaces: the narrow no-break one a locale puts before "PM" is no use in a sentence the agent and a test read too.)
  const time = new Intl.DateTimeFormat(options.locale, { hour: "numeric", minute: "2-digit", ...zone }).format(until).replace(/[\u202f\u00a0]/gu, " ");
  const day = (instant: number): string => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...zone }).format(instant);
  const DAY_MS = 86_400_000;
  if (day(until) === day(now)) return `today ${time}`;
  if (day(until) === day(now + DAY_MS)) return `tomorrow ${time}`;
  if (until > now && until - now < 7 * DAY_MS) return `${new Intl.DateTimeFormat(options.locale, { weekday: "short", ...zone }).format(until)} ${time}`;
  return `${new Intl.DateTimeFormat(options.locale, { month: "short", day: "numeric", ...zone }).format(until)}, ${time}`;
}

/** One line under an away space's name: "Back Sun 8:00 AM · Game day", "Away · Pistachio", "Away". */
export function awayLine(info: Pick<AwaySpaceInfo, "by" | "until" | "waiting">, now: number, options: { timeZone?: string; locale?: string } = {}): string {
  const who = awayHolderName(info.by);
  const when = info.waiting === "room" ? "Due back · no room for it" : info.until === undefined ? "Away" : `Back ${formatReturn(info.until, now, options)}`;
  return who === null ? when : `${when} · ${who}`;
}
