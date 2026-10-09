/**
 * Tab groups — what a person calls SPACES (docs/spaces.md): where browsing
 * happens, the unit tabs, files and an AI conversation belong to. The
 * sidebar draws one as ONE row that opens on hover (docs/tab-tidy.md §3.3);
 * on the desktop it is shown as its desk (docs/desk.md). Shared between
 * main, which owns the groups beside the split groups and applies every
 * change, and the renderers, which read them off the snapshot and ask for
 * changes with a TabGroupCommand.
 *
 * Vocabulary, because the names here predate the word: a space is a tab
 * group (TabGroupInfo); what the code calls a Space (`spaceId`,
 * MAX_TAB_GROUPS_PER_SPACE) is a person's PROFILE — the partition with its
 * own cookie jar. The identifiers keep their names (they are on the wire and
 * in files); a comment that could be read either way says "space (tab
 * group)" or "Profile (Space)".
 *
 * A space may be EMPTY (since 2026-10-09): one made with no tabs (New
 * space), or one that is the person's (isPersonsGroup) outliving its last
 * tab. Until then an emptied group dissolved at every layer — withoutTabs,
 * sanitizeTabGroups, the `create` check. This file only lets an empty space
 * be; main's reconcile decides whether one stays, since only it can ask the
 * Stack and the conversations.
 *
 * A group is not a split group: a split is 2–4 tabs SHOWN together, a tab
 * group is any number of tabs KEPT together. A tab may be in both — "open
 * group as split view" makes exactly that (the web's alone since
 * 2026-10-09: the desktop's desk tiles windows instead).
 *
 * `origin` is who the group belongs to. Tidy makes `auto` groups and may
 * archive one once every tab in it has gone idle; the moment a person
 * renames, recolours, or adds a tab to it, it is `manual` — theirs — and
 * Tidy only ever adds tabs to it.
 *
 * Pure on purpose — no Electron, no DOM — so vitest pins it under node.
 */

export const TAB_GROUP_COLORS = ["gray", "green", "blue", "purple", "amber", "pink", "red", "orange"] as const;
export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

export function isTabGroupColor(value: unknown): value is TabGroupColor {
  return typeof value === "string" && (TAB_GROUP_COLORS as readonly string[]).includes(value);
}

export type TabGroupOrigin = "auto" | "manual";

export interface TabGroupInfo {
  id: string;
  title: string;
  color: TabGroupColor;
  /**
   * The members, in the order the group lists them — the order they hold in
   * the tab row too. May be EMPTY for a drawn space (since 2026-10-09: one
   * made with none, or the person's after its last tab went — it then stands
   * at `beforeUnit`); never for a loose tab's or a page's, which are their
   * one tab's.
   */
  tabIds: string[];
  origin: TabGroupOrigin;
  /** Held open by a click on its header; otherwise it opens on hover only. */
  open: boolean;
  createdAt: number;
  /**
   * The host is asking the model what to call it (a group made by hand with
   * no title, docs/tab-tidy.md §3.3): the row says so instead of showing the
   * placeholder. Of the moment only — never stored, never restored.
   */
  naming?: boolean;
  /**
   * A loose tab's group (docs/desk.md, "A loose tab's desk"): made for a day
   * tab in no group chosen while a desk is up, so its desk has all a
   * group's does — the Bar, its conversation, the Stack, files dropped on
   * it. It holds that one tab and is drawn as the tab alone, never as a
   * group: the snapshot lists it apart (ShellSnapshot.looseGroups), and Tidy
   * treats its tab as loose. Given a second tab, it is a group like any
   * other (named, coloured, drawn); its tab put in another group, it is
   * gone, as any group emptied is — unless it is the person's
   * (isPersonsGroup: a Stack, a conversation), when it stays as a drawn
   * empty space (withoutTabs). An `auto` group left with one tab becomes
   * that tab's loose one in place, keeping its id (since 2026-10-09; until
   * then it dissolved, and a loose group was made afresh with a new id).
   */
  loose?: boolean;
  /**
   * A page's group (docs/desk.md, "A page's group"): led by the page of a
   * sidebar entry — a favorite, an organization's preset or a pin, whose
   * anchor this is — and holding the tabs opened on that page's desk (⌘T, a
   * link, a tab dropped there) as day tabs. Its desk has all a group's does.
   * The page stays its entry's, and the group is never drawn among the
   * day's tabs: the snapshot lists it apart (ShellSnapshot.anchorGroups),
   * the sidebar draws its tabs under its entry while its desk is up, and
   * Tidy leaves them be until the favorites reset archives the group or
   * brings it down (docs/tab-tidy.md §3.7). Its page let go of its entry —
   * brought down into the day's tabs, closed, put in a split view — it is a
   * group like any other (or, of one tab, a loose tab's).
   */
  anchorId?: string;
  /**
   * Where an EMPTY space stands among the day's row units (dayRowUnits):
   * the unit it is drawn before — a tab's id, `split:<id>` or `group:<id>`,
   * as tabGroupUnitId and dayRowUnits name them. Absent, or naming a unit
   * that is not there, it stands after every unit, empty spaces by
   * `createdAt`. Main sets it as the space empties — where its last tab was,
   * so it does not jump to the end — and clears it once the space holds a
   * tab again, which goes into the tab order there. Meaningless on a space
   * with tabs, which stands where its first tab does (groupedTabOrder);
   * sanitizeTabGroups drops it there.
   */
  beforeUnit?: string;
}

/** The drawn spaces (tab groups) a Profile (Space) may hold, empty ones among them. */
export const MAX_TAB_GROUPS_PER_SPACE = 50;
/**
 * Loose tabs' groups (TabGroupInfo.loose) are kept apart from that bound,
 * with pages' groups (TabGroupInfo.anchorId): one is made for every day tab
 * or sidebar entry's page chosen on a desk, so a Space has as many as it has
 * such tabs, and none may push a drawn group (or another) out.
 */
export const MAX_LOOSE_TAB_GROUPS_PER_SPACE = 2_000;
export const MAX_TAB_GROUP_TITLE = 40;
/** What a space nobody named is called ("New group" until 2026-10-09, read as this from files: storedTabGroupTitle). */
export const DEFAULT_TAB_GROUP_TITLE = "New space";
/** The default title before 2026-10-09, when a space was still a group. */
const LEGACY_DEFAULT_TAB_GROUP_TITLE = "New group";

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/i;

export function isTabGroupId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

/** A row unit's id as TabGroupInfo.beforeUnit names one: a tab's (≤192), or `split:`/`group:` and an id. */
function isUnitId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** A title as the row draws it: one line, trimmed, bounded; never empty. */
export function tabGroupTitle(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TAB_GROUP_TITLE;
  const title = value.replace(/\s+/gu, " ").trim().slice(0, MAX_TAB_GROUP_TITLE).trim();
  return title === "" ? DEFAULT_TAB_GROUP_TITLE : title;
}

/**
 * A title read back from a file — a session's space, an archived one's — as
 * tabGroupTitle draws it, with the default from before 2026-10-09 ("New
 * group", exactly) read as today's: a space nobody named still IS the
 * default (DEFAULT_TAB_GROUP_TITLE, which the sidebar compares against to
 * open a new space's name field). Not for a name a person types now — that
 * is theirs, whatever it says.
 */
export function storedTabGroupTitle(value: unknown): string {
  const title = tabGroupTitle(value);
  return title === LEGACY_DEFAULT_TAB_GROUP_TITLE ? DEFAULT_TAB_GROUP_TITLE : title;
}

/**
 * The colour a new group takes when nobody chose one: the first the Space's
 * other groups are not already using, so neighbours differ; past eight groups
 * it cycles. Gray is last — it reads as "no colour".
 */
export function nextTabGroupColor(groups: readonly Pick<TabGroupInfo, "color">[]): TabGroupColor {
  const order: TabGroupColor[] = ["blue", "amber", "green", "purple", "pink", "orange", "red", "gray"];
  const used = new Set(groups.map((group) => group.color));
  return order.find((color) => !used.has(color)) ?? order[groups.length % order.length] ?? "blue";
}

/**
 * Groups read back from a file, or handed over by another device. A member
 * that is not one of the Space's groupable tabs is dropped — except a page's
 * group's own page (`anchoredTabs`: each anchored tab's anchor) — and a tab
 * belongs to the first group that names it. A page's group whose page is
 * gone is a group like any other, or of one tab a loose tab's.
 *
 * A group left with no members is an EMPTY SPACE and kept (since
 * 2026-10-09; until then it was gone), with its `beforeUnit`, within the
 * drawn spaces' bound — but only a drawn one: a loose tab's or a page's
 * group is its tab's, and with none it is nothing. Whether an empty space
 * is the person's, and so stays, is not this read's to say: main's
 * reconcile asks (isPersonsGroup). The default title from before
 * 2026-10-09 reads as today's (storedTabGroupTitle).
 */
export function sanitizeTabGroups(value: unknown, groupableTabIds: ReadonlySet<string>, anchoredTabs: ReadonlyMap<string, string> = new Map()): TabGroupInfo[] {
  if (!Array.isArray(value)) return [];
  const groups: TabGroupInfo[] = [];
  const claimed = new Set<string>();
  const seen = new Set<string>();
  let drawn = 0;
  let loose = 0;
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const raw = candidate as Record<string, unknown>;
    const id = raw["id"];
    if (!isTabGroupId(id) || seen.has(id) || !Array.isArray(raw["tabIds"])) continue;
    const anchor = typeof raw["anchorId"] === "string" && raw["anchorId"] !== "" ? raw["anchorId"] : undefined;
    const tabIds: string[] = [];
    let led = false;
    for (const tabId of raw["tabIds"]) {
      if (typeof tabId !== "string" || claimed.has(tabId)) continue;
      const page = anchor !== undefined && anchoredTabs.get(tabId) === anchor;
      if (!page && !groupableTabIds.has(tabId)) continue;
      led ||= page;
      claimed.add(tabId);
      tabIds.push(tabId);
    }
    // An empty space is a drawn one: a loose tab's or a page's group without its tab is nothing.
    const empty = tabIds.length === 0;
    if (empty && (raw["loose"] === true || anchor !== undefined)) continue;
    // A page's group with its page; without it, its tabs are a group like any other — a loose tab's, of one.
    const anchorId = led ? anchor : undefined;
    // Each kind within its own bound: a loose tab's group is of its one tab, and neither it nor a page's is drawn.
    const isLoose = anchorId === undefined && (raw["loose"] === true || anchor !== undefined) && tabIds.length === 1;
    if (isLoose || anchorId !== undefined ? loose >= MAX_LOOSE_TAB_GROUPS_PER_SPACE : drawn >= MAX_TAB_GROUPS_PER_SPACE) {
      for (const tabId of tabIds) claimed.delete(tabId);
      continue;
    }
    if (isLoose || anchorId !== undefined) loose += 1;
    else drawn += 1;
    seen.add(id);
    const createdAt = raw["createdAt"];
    const beforeUnit = raw["beforeUnit"];
    groups.push({
      id,
      title: storedTabGroupTitle(raw["title"]),
      color: isTabGroupColor(raw["color"]) ? raw["color"] : "gray",
      tabIds,
      origin: raw["origin"] === "auto" ? "auto" : "manual",
      open: raw["open"] === true,
      createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : 0,
      // (A loose tab's group holds its one tab: with more, it is a group like any other.)
      ...(isLoose ? { loose: true } : {}),
      ...(anchorId !== undefined ? { anchorId } : {}),
      // (Only an empty space stands by its unit: one with tabs stands where its first tab does.)
      ...(empty && isUnitId(beforeUnit) ? { beforeUnit } : {}),
    });
  }
  return groups;
}

/** The tabs of the pages' groups (TabGroupInfo.anchorId): listed under their entries, never among the day's tabs. */
export function anchorGroupTabIds(groups: readonly TabGroupInfo[]): Set<string> {
  return new Set(groups.flatMap((group) => (group.anchorId === undefined ? [] : group.tabIds)));
}

/** The group a tab is in, or null. */
export function tabGroupOf(groups: readonly TabGroupInfo[], tabId: string): TabGroupInfo | null {
  return groups.find((group) => group.tabIds.includes(tabId)) ?? null;
}

/**
 * Groups after some tabs went away (closed, pinned, moved to another Profile
 * (Space), put in another group): the tabs leave their groups, and a group
 * that lost some is —
 *
 * - left EMPTY: gone, unless `keep` says it is the person's (isPersonsGroup),
 *   when it stays an empty space, `tabIds: []`. A loose tab's kept so is
 *   drawn from then on (it has no tab to be drawn as); a page's keeps its
 *   `anchorId` for the caller to let go of, as one left without its page
 *   but with other tabs does (main's reconcile, which titles it after its
 *   entry).
 * - an `auto` group left with ONE tab, not kept: that tab's loose space IN
 *   PLACE (`loose`, grey), keeping its id — what the desk and the agent
 *   track it by. Kept, it stays drawn; so does a `manual` group of one tab,
 *   as it always did.
 *
 * (Until 2026-10-09 an emptied group dissolved whatever it held, and so did
 * an auto group of one, its tab left in no group for main to make a loose
 * one afresh, with a new id.) `keep` is asked only of a group that lost
 * tabs, as it was before it lost them; absent, nothing is kept. Returns the
 * same array when nothing changed, so callers can tell.
 */
export function withoutTabs(
  groups: readonly TabGroupInfo[],
  gone: ReadonlySet<string>,
  keep?: (group: TabGroupInfo) => boolean,
): readonly TabGroupInfo[] {
  if (gone.size === 0 || !groups.some((group) => group.tabIds.some((id) => gone.has(id)))) return groups;
  const next: TabGroupInfo[] = [];
  for (const group of groups) {
    const tabIds = group.tabIds.filter((id) => !gone.has(id));
    if (tabIds.length === group.tabIds.length) {
      next.push(group);
      continue;
    }
    const kept = keep?.(group) === true;
    if (tabIds.length === 0) {
      if (!kept) continue;
      const { loose: _loose, ...drawn } = group;
      next.push({ ...drawn, tabIds });
      continue;
    }
    if (group.origin === "auto" && group.anchorId === undefined && tabIds.length === 1 && !kept) {
      next.push({ ...group, tabIds, loose: true, color: "gray" });
      continue;
    }
    next.push({ ...group, tabIds });
  }
  return next;
}

/**
 * Whether a space (tab group) is the PERSON'S (docs/spaces.md §1, "An empty
 * space"): it outlives its last tab, Tidy neither archives it nor undoes it
 * from under them, and Ungroup leaves it standing. It is theirs when they
 * made or touched it by hand — a drawn `manual` group — or when it holds
 * what is theirs: a Stack with something in it (`context`), a conversation
 * bound to it whose thread still exists (`conversation`), or a desk turn
 * running in it (`held`, main's holdGroup). Main asks the stores and passes
 * what they said; this is the rule, pure so vitest pins it.
 *
 * `origin: "manual"` alone is not enough: every shell `create` passes
 * manual — a loose tab's and a page's included — and so does main's own
 * page's group, so a loose or a page's space is the person's only through
 * what it holds.
 */
export function isPersonsGroup(
  group: Pick<TabGroupInfo, "origin" | "loose" | "anchorId">,
  has: { context: boolean; conversation: boolean; held: boolean },
): boolean {
  return (group.origin === "manual" && group.loose !== true && group.anchorId === undefined) || has.context || has.conversation || has.held;
}

/**
 * The tab row's order with every group's members made contiguous: a group
 * sits where its FIRST member (in row order) sits, and its other members
 * follow it in the group's own order. Tabs in no group keep their relative
 * order. The browser holds ONE order for all tabs, so this is what keeps a
 * group one row: call it after anything that forms or changes a group. An
 * empty space has no tab to place: it stands by its `beforeUnit` among the
 * row units (dayRowUnits), never in this order.
 */
export function groupedTabOrder(order: readonly string[], groups: readonly TabGroupInfo[]): string[] {
  const groupOfTab = new Map<string, TabGroupInfo>();
  for (const group of groups) for (const tabId of group.tabIds) groupOfTab.set(tabId, group);
  const present = new Set(order);
  const placed = new Set<string>();
  const next: string[] = [];
  for (const tabId of order) {
    const group = groupOfTab.get(tabId);
    if (group === undefined) {
      next.push(tabId);
      continue;
    }
    if (placed.has(group.id)) continue;
    placed.add(group.id);
    for (const member of group.tabIds) if (present.has(member)) next.push(member);
  }
  return next;
}

/* ------------------------------ row units ------------------------------- */

/**
 * One slot among the day's tabs as the chrome lays them out: a lone tab, a
 * split view, or a tab group — which holds its members, split or not. Main
 * and the shell both count drops in these units (`TabGroupCommand` "move",
 * the shelf drag's "today" index), so they are computed in one place.
 */
export interface DayRowUnit {
  /** The tab's id, `split:<id>`, or `group:<id>`. */
  id: string;
  kind: "tab" | "split" | "group";
  /** Its tabs here, in row order; none for an empty space's (TabGroupInfo.beforeUnit). */
  tabIds: string[];
}

export const tabGroupUnitId = (groupId: string): string => `group:${groupId}`;

/**
 * The day's row units: each tab where it is in `dayTabIds`, a split one
 * unit, a group one unit at its first member — and, since 2026-10-09, each
 * EMPTY drawn space (a group of `tabGroups` with no tabs, neither loose nor
 * a page's) as a unit of its own with `tabIds: []`, before the unit its
 * `beforeUnit` names when that unit is here (another empty space's
 * included), else after everything, empty spaces by `createdAt`. Every
 * counter of drops counts the same units, empty ones included, so a caller
 * that turns an index into a tab (`tabIds[0]`: main's #placeAtDayUnit, the
 * shelf drag's reorderDayTabs) finds none at an empty space's unit and must
 * take the first unit after it that has one.
 */
export function dayRowUnits(
  dayTabIds: readonly string[],
  splitGroups: readonly { id: string; tabIds: readonly string[] }[],
  tabGroups: readonly TabGroupInfo[],
): DayRowUnit[] {
  const day = new Set(dayTabIds);
  const groupOfTab = new Map<string, TabGroupInfo>();
  for (const group of tabGroups) for (const tabId of group.tabIds) groupOfTab.set(tabId, group);
  const splitOfTab = new Map<string, { id: string; tabIds: readonly string[] }>();
  for (const split of splitGroups) {
    // A split is one slot only when all of it is here, and outside any tab group.
    if (!split.tabIds.every((tabId) => day.has(tabId) && !groupOfTab.has(tabId))) continue;
    for (const tabId of split.tabIds) splitOfTab.set(tabId, split);
  }
  const units: DayRowUnit[] = [];
  const placed = new Set<string>();
  for (const tabId of dayTabIds) {
    const group = groupOfTab.get(tabId);
    const split = splitOfTab.get(tabId);
    const id = group !== undefined ? tabGroupUnitId(group.id) : split !== undefined ? `split:${split.id}` : tabId;
    if (placed.has(id)) continue;
    placed.add(id);
    if (group !== undefined) units.push({ id, kind: "group", tabIds: group.tabIds.filter((member) => day.has(member)) });
    else if (split !== undefined) units.push({ id, kind: "split", tabIds: [...split.tabIds] });
    else units.push({ id, kind: "tab", tabIds: [tabId] });
  }
  return withEmptySpaces(units, tabGroups);
}

/**
 * `units` with the empty drawn spaces of `tabGroups` set in (dayRowUnits).
 * They go in `createdAt` order (the list's own on a tie), each before its
 * `beforeUnit` once that unit is in — so two before one unit stand oldest
 * first, and one before another empty space waits for it. When none left
 * can go in, the oldest whose unit will never come (gone, unnamed, itself;
 * on a ring of empty spaces naming each other, simply the oldest) goes at
 * the end, and the rest try again.
 */
function withEmptySpaces(units: DayRowUnit[], tabGroups: readonly TabGroupInfo[]): DayRowUnit[] {
  let pending = tabGroups
    .map((group, order) => ({ group, order }))
    .filter(({ group }) => group.tabIds.length === 0 && group.loose !== true && group.anchorId === undefined)
    .sort((a, b) => a.group.createdAt - b.group.createdAt || a.order - b.order)
    .map(({ group }) => group);
  if (pending.length === 0) return units;
  const placed = [...units];
  const unitOf = (group: TabGroupInfo): DayRowUnit => ({ id: tabGroupUnitId(group.id), kind: "group", tabIds: [] });
  while (pending.length > 0) {
    const waiting: TabGroupInfo[] = [];
    for (const group of pending) {
      const at = group.beforeUnit === undefined ? -1 : placed.findIndex((unit) => unit.id === group.beforeUnit);
      if (at >= 0) placed.splice(at, 0, unitOf(group));
      else waiting.push(group);
    }
    if (waiting.length < pending.length) {
      pending = waiting;
      continue;
    }
    const waitingFor = new Set(waiting.map((group) => tabGroupUnitId(group.id)));
    const blocked = (group: TabGroupInfo): boolean =>
      group.beforeUnit !== undefined && group.beforeUnit !== tabGroupUnitId(group.id) && waitingFor.has(group.beforeUnit);
    const last = waiting.find((group) => !blocked(group)) ?? waiting[0]!;
    placed.push(unitOf(last));
    pending = waiting.filter((group) => group !== last);
  }
  return placed;
}

/* ------------------------------ commands -------------------------------- */

/** What a command gave back: closing a group files it, and Undo needs to know where. */
export interface TabGroupCommandResult {
  archivedEntryId: string | null;
}


/**
 * Everything the chrome can ask of the groups. Main applies one and
 * publishes; a command that names something that is gone is a no-op, never
 * an error — the row it came from was already stale.
 */
export type TabGroupCommand =
  /**
   * Make a group from day tabs (they leave any group they were in). The renderer names the id so it can start renaming at
   * once. `loose`: a loose tab's group (TabGroupInfo.loose), of one tab. `anchored`: a page's group (TabGroupInfo.anchorId),
   * of one tab, a sidebar entry's page — or, that entry having one already, nothing. With no tabs, neither loose nor
   * anchored (since 2026-10-09): an empty space in the active Profile (Space) — "New space". `select`: make it the current
   * space at once, as `select` does.
   */
  | { type: "create"; id: string; tabIds: string[]; title?: string; color?: TabGroupColor; loose?: boolean; anchored?: boolean; select?: boolean }
  /**
   * Make the space current (docs/spaces.md §2; main owns which one is, ShellSnapshot.currentGroupId): main activates
   * `tabId` if it is the space's, else the space's tab used last, else nothing — an empty space, `activeTabId` null. The
   * shell passes the window that was on top when the space was left, since the arrangement is the shell's.
   */
  | { type: "select"; groupId: string; tabId?: string }
  | { type: "rename"; groupId: string; title: string }
  | { type: "recolor"; groupId: string; color: TabGroupColor }
  /** Hold the group open, or let it close when the pointer leaves. */
  | { type: "setOpen"; groupId: string; open: boolean }
  /** Put a day tab in the group, at `index` among its members (the end when absent). */
  | { type: "addTab"; groupId: string; tabId: string; index?: number }
  /** Take a tab out; it stays open, placed straight after the group. */
  | { type: "removeTab"; tabId: string }
  /** A new tab that starts life in the group, and is shown. */
  | { type: "newTab"; groupId: string }
  /** Dissolve the group; its tabs stay where they are. */
  | { type: "ungroup"; groupId: string }
  /** Close every tab in the group and file it in the archive as one entry (docs/tab-tidy.md §3.5). */
  | { type: "close"; groupId: string }
  /** Show the group's tabs side by side — up to four of them (§3.4). The web host's: the desktop's desk tiles windows instead. */
  | { type: "openAsSplit"; groupId: string }
  /** Move the whole group to `index` among the day's ROW UNITS (lone tabs, splits, groups), counted without it. */
  | { type: "move"; groupId: string; index: number };

const COMMAND_TYPES: ReadonlySet<string> = new Set([
  "create",
  "select",
  "rename",
  "recolor",
  "setOpen",
  "addTab",
  "removeTab",
  "newTab",
  "ungroup",
  "close",
  "openAsSplit",
  "move",
]);

function isTabId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 192;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The IPC boundary's check: a renderer sends these, main believes nothing else. */
export function isTabGroupCommand(value: unknown): value is TabGroupCommand {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  const type = raw["type"];
  if (typeof type !== "string" || !COMMAND_TYPES.has(type)) return false;
  switch (type) {
    case "create":
      // (No tabs is an empty space: the loose and anchored checks below want their one tab, so neither is one.)
      return (
        isTabGroupId(raw["id"]) &&
        Array.isArray(raw["tabIds"]) &&
        raw["tabIds"].length <= 200 &&
        raw["tabIds"].every(isTabId) &&
        (raw["title"] === undefined || typeof raw["title"] === "string") &&
        (raw["color"] === undefined || isTabGroupColor(raw["color"])) &&
        (raw["loose"] === undefined || (typeof raw["loose"] === "boolean" && (raw["loose"] === false || raw["tabIds"].length === 1))) &&
        (raw["anchored"] === undefined || (typeof raw["anchored"] === "boolean" && (raw["anchored"] === false || (raw["tabIds"].length === 1 && raw["loose"] !== true)))) &&
        (raw["select"] === undefined || typeof raw["select"] === "boolean")
      );
    case "select":
      return isTabGroupId(raw["groupId"]) && (raw["tabId"] === undefined || isTabId(raw["tabId"]));
    case "rename":
      return isTabGroupId(raw["groupId"]) && typeof raw["title"] === "string";
    case "recolor":
      return isTabGroupId(raw["groupId"]) && isTabGroupColor(raw["color"]);
    case "setOpen":
      return isTabGroupId(raw["groupId"]) && typeof raw["open"] === "boolean";
    case "addTab":
      return isTabGroupId(raw["groupId"]) && isTabId(raw["tabId"]) && (raw["index"] === undefined || isIndex(raw["index"]));
    case "removeTab":
      return isTabId(raw["tabId"]);
    case "move":
      return isTabGroupId(raw["groupId"]) && isIndex(raw["index"]);
    default:
      return isTabGroupId(raw["groupId"]);
  }
}

/* ------------------------------ split view ------------------------------ */

/**
 * Which of a group's tabs "open as split view" shows: all of them up to
 * `max`, and for a larger group the `max` most recently used — still in the
 * group's own order, so the panes read the way the rows do.
 */
export function splitMembersOf(
  group: Pick<TabGroupInfo, "tabIds">,
  lastActiveAt: (tabId: string) => number,
  max: number,
): string[] {
  if (group.tabIds.length <= max) return [...group.tabIds];
  const recent = new Set(
    [...group.tabIds]
      .sort((a, b) => lastActiveAt(b) - lastActiveAt(a))
      .slice(0, max),
  );
  return group.tabIds.filter((tabId) => recent.has(tabId));
}
