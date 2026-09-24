/**
 * Tab groups: a titled, coloured run of the day's tabs that the sidebar draws
 * as ONE row and opens on hover (docs/tab-tidy.md §3.3). Shared between main,
 * which owns the groups beside the split groups and applies every change, and
 * the renderers, which read them off the snapshot and ask for changes with a
 * TabGroupCommand.
 *
 * A group is not a split group: a split is 2–4 tabs SHOWN together, a tab
 * group is any number of tabs KEPT together. A tab may be in both — "open
 * group as split view" makes exactly that.
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
  /** The members, in the order the group lists them — the order they hold in the tab row too. */
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
}

export const MAX_TAB_GROUPS_PER_SPACE = 50;
export const MAX_TAB_GROUP_TITLE = 40;
export const DEFAULT_TAB_GROUP_TITLE = "New group";

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/i;

export function isTabGroupId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

/** A title as the row draws it: one line, trimmed, bounded; never empty. */
export function tabGroupTitle(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TAB_GROUP_TITLE;
  const title = value.replace(/\s+/gu, " ").trim().slice(0, MAX_TAB_GROUP_TITLE).trim();
  return title === "" ? DEFAULT_TAB_GROUP_TITLE : title;
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
 * that is not one of the Space's groupable tabs is dropped, a tab belongs to
 * the first group that names it, and a group left with no members is gone.
 */
export function sanitizeTabGroups(value: unknown, groupableTabIds: ReadonlySet<string>): TabGroupInfo[] {
  if (!Array.isArray(value)) return [];
  const groups: TabGroupInfo[] = [];
  const claimed = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const raw = candidate as Record<string, unknown>;
    const id = raw["id"];
    if (!isTabGroupId(id) || seen.has(id) || !Array.isArray(raw["tabIds"])) continue;
    const tabIds: string[] = [];
    for (const tabId of raw["tabIds"]) {
      if (typeof tabId !== "string" || !groupableTabIds.has(tabId) || claimed.has(tabId)) continue;
      claimed.add(tabId);
      tabIds.push(tabId);
    }
    if (tabIds.length === 0) continue;
    seen.add(id);
    const createdAt = raw["createdAt"];
    groups.push({
      id,
      title: tabGroupTitle(raw["title"]),
      color: isTabGroupColor(raw["color"]) ? raw["color"] : "gray",
      tabIds,
      origin: raw["origin"] === "auto" ? "auto" : "manual",
      open: raw["open"] === true,
      createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : 0,
    });
    if (groups.length === MAX_TAB_GROUPS_PER_SPACE) break;
  }
  return groups;
}

/** The group a tab is in, or null. */
export function tabGroupOf(groups: readonly TabGroupInfo[], tabId: string): TabGroupInfo | null {
  return groups.find((group) => group.tabIds.includes(tabId)) ?? null;
}

/**
 * Groups after some tabs went away (closed, pinned, moved to another Space):
 * the tabs leave their groups, and a group left empty — or an `auto` group
 * left with one tab, which is no longer a group of anything — dissolves.
 * Returns the same array when nothing changed, so callers can tell.
 */
export function withoutTabs(groups: readonly TabGroupInfo[], gone: ReadonlySet<string>): readonly TabGroupInfo[] {
  if (gone.size === 0 || !groups.some((group) => group.tabIds.some((id) => gone.has(id)))) return groups;
  const next: TabGroupInfo[] = [];
  for (const group of groups) {
    const tabIds = group.tabIds.filter((id) => !gone.has(id));
    if (tabIds.length === group.tabIds.length) {
      next.push(group);
      continue;
    }
    if (tabIds.length === 0 || (group.origin === "auto" && tabIds.length < 2)) continue;
    next.push({ ...group, tabIds });
  }
  return next;
}

/**
 * The tab row's order with every group's members made contiguous: a group
 * sits where its FIRST member (in row order) sits, and its other members
 * follow it in the group's own order. Tabs in no group keep their relative
 * order. The browser holds ONE order for all tabs, so this is what keeps a
 * group one row: call it after anything that forms or changes a group.
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
  tabIds: string[];
}

export const tabGroupUnitId = (groupId: string): string => `group:${groupId}`;

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
  return units;
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
  /** Make a group from day tabs (they leave any group they were in). The renderer names the id so it can start renaming at once. */
  | { type: "create"; id: string; tabIds: string[]; title?: string; color?: TabGroupColor }
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
  /** Show the group's tabs side by side — up to four of them (§3.4). */
  | { type: "openAsSplit"; groupId: string }
  /** Move the whole group to `index` among the day's ROW UNITS (lone tabs, splits, groups), counted without it. */
  | { type: "move"; groupId: string; index: number };

const COMMAND_TYPES: ReadonlySet<string> = new Set([
  "create",
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
      return (
        isTabGroupId(raw["id"]) &&
        Array.isArray(raw["tabIds"]) &&
        raw["tabIds"].length > 0 &&
        raw["tabIds"].length <= 200 &&
        raw["tabIds"].every(isTabId) &&
        (raw["title"] === undefined || typeof raw["title"] === "string") &&
        (raw["color"] === undefined || isTabGroupColor(raw["color"]))
      );
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
