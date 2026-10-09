/**
 * The shell's half of spaces (docs/spaces.md, since 2026-10-09): the desk is
 * the desktop's surface, so splits are the web's alone (splitAvailable, the
 * surface's, never the desk's engine's); the sidebar draws an EMPTY space as
 * a unit of its own, its row its name and a ring of its colour; the empty
 * desk says whose it is and what can be done; "New space" is an empty
 * `create` that is current at once; and a space's row chooses it with main's
 * `select`, naming the window that was on top when it was left. A row let
 * go beside an empty space is placed by the units as drawn (main's
 * `reorderTab(…, "units")`), and a favorite or pin let go on the current
 * empty space's header comes out on the desk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NATIVE_SURFACE_MEMBERS, type ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import type { TabGroupCommand, TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { CHROME_ACTIONS, runConfiguredShortcut, shortcutOfferedHere, type ActionContext } from "../src/chrome/actions";
import { reorderDayTabs } from "../src/chrome/shelf-drag";
import { dayUnits, dayUnitsInHand, type ChromeTab } from "../src/chrome/tabs";
import { DeskEmpty } from "../src/components/desk/DeskEmpty";
import { TabGroupRow } from "../src/components/TabGroupRow";
import { bringOutJoined, deskAvailable, lendDeskEngine, newSpace, revealFor, selectSpace, shortcutSurface, splitAvailable, takeSpaceChoice } from "../src/lib/desk/open";
import type { DeskEngine } from "../src/components/desk/desk-engine";
import { useDeskStore } from "../src/lib/desk/store";
import { listDropAt, type MeasuredRow } from "../src/lib/sidebar-tree";
import { useAppStore } from "../src/store";

/** A bridge with every native member: the desktop, where the desk is. */
function desktop(extra: Record<string, unknown> = {}): void {
  setShellApi({ ...Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()])), ...extra } as unknown as ShellApiBridge);
}

/** A bridge with none of them: the web's stream surface. */
function web(extra: Record<string, unknown> = {}): void {
  setShellApi(extra as unknown as ShellApiBridge);
}

const group = (id: string, tabIds: string[], fields: Partial<TabGroupInfo> = {}): TabGroupInfo => ({
  id,
  title: id.toUpperCase(),
  color: "blue",
  tabIds,
  origin: "manual",
  open: false,
  createdAt: 1,
  ...fields,
});

const tab = (id: string): ChromeTab => ({ id, title: id, url: `https://${id}.example/`, faviconUrl: null, anchorId: null, active: false, splitGroup: null }) as unknown as ChromeTab;

afterEach(() => {
  web();
});

describe("splits are the web's (splitAvailable)", () => {
  it("are not offered on the desktop, whatever the desk's engine is doing — and are on the web", () => {
    desktop();
    expect(deskAvailable()).toBe(true);
    expect(splitAvailable()).toBe(false);
    expect(shortcutSurface()).toBe("native");
    const ctx = {} as ActionContext;
    expect(CHROME_ACTIONS.toggleSplit.enabled?.(ctx)).toBe(false);
    expect(shortcutOfferedHere("toggleSplit")).toBe(false);
    expect(shortcutOfferedHere("tileDesk")).toBe(true);
    web();
    expect(splitAvailable()).toBe(true);
    expect(CHROME_ACTIONS.toggleSplit.enabled?.(ctx)).toBe(true);
    expect(shortcutOfferedHere("toggleSplit")).toBe(true);
    expect(shortcutOfferedHere("tileDesk")).toBe(false);
  });

  it("leaves a key no surface offers alone: Toggle desk is retired", () => {
    desktop();
    const host = { state: {} as never, run: vi.fn() };
    expect(shortcutOfferedHere("toggleDesk")).toBe(false);
    expect(runConfiguredShortcut("toggleDesk", host)).toBe(false);
    // ⌘\ on the desktop is no one's: the split's runner answers false, so the key goes on to whatever else wants it.
    expect(runConfiguredShortcut("toggleSplit", host)).toBe(false);
    expect(host.run).not.toHaveBeenCalled();
  });
});

describe("an empty space in the sidebar", () => {
  it("is a unit of the day's rows where it stands (its beforeUnit), with no tabs", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const groups = [group("full", ["b"]), group("empty", [], { beforeUnit: "c" })];
    const units = dayUnits(tabs, groups, [], new Set());
    expect(units.map((unit) => unit.id)).toEqual(["a", "group:full", "group:empty", "c"]);
    const empty = units.find((unit) => unit.id === "group:empty");
    expect(empty).toMatchObject({ kind: "group", tabs: [], rows: [] });
  });

  it("stands after every unit when it names none that is there", () => {
    const units = dayUnits([tab("a")], [group("empty", [], { beforeUnit: "gone" })], [], new Set());
    expect(units.map((unit) => unit.id)).toEqual(["a", "group:empty"]);
  });

  it("is drawn as its name and a ring of its colour: no count, no split, no desk button, nothing under it", () => {
    const html = renderToStaticMarkup(
      // (The row's props require children; createElement with a third argument would not satisfy the type.)
      // eslint-disable-next-line react/no-children-prop
      createElement(TabGroupRow, {
        group: group("empty", []),
        flipId: "group:empty",
        tabs: [],
        expanded: true,
        held: false,
        renaming: false,
        onHover: () => undefined,
        onToggleOpen: () => undefined,
        onRename: () => undefined,
        onClose: () => undefined,
        onPointerDown: () => undefined,
        onContextMenu: () => undefined,
        children: null,
      }),
    );
    expect(html).toContain('data-testid="space-empty-mark"');
    expect(html).toContain("data-empty");
    expect(html).toContain("EMPTY");
    expect(html).not.toContain('data-testid="tab-group-count"');
    expect(html).not.toContain('data-testid="tab-group-split"');
    expect(html).not.toContain('data-testid="tab-group-desk"');
    expect(html).not.toContain('data-testid="tab-group-members"');
    expect(html).not.toContain("0 tabs");
  });

  it("holding something in its Stack, has the Stack's pile over its ring; the current one says so", () => {
    const html = renderToStaticMarkup(
      // (The row's props require children; createElement with a third argument would not satisfy the type.)
      // eslint-disable-next-line react/no-children-prop
      createElement(TabGroupRow, {
        group: group("kept", []),
        flipId: "group:kept",
        tabs: [],
        expanded: false,
        held: false,
        renaming: false,
        current: true,
        stack: 2,
        onHover: () => undefined,
        onToggleOpen: () => undefined,
        onRename: () => undefined,
        onClose: () => undefined,
        onPointerDown: () => undefined,
        onContextMenu: () => undefined,
        children: null,
      }),
    );
    expect(html).toContain("tab-group-ring-stack");
    expect(html).toContain("data-current");
  });
});

describe("the empty desk", () => {
  it("says whose space it is, offers a new tab with its key, and takes files", () => {
    const html = renderToStaticMarkup(createElement(DeskEmpty, { title: "Trip to Lisbon" }));
    expect(html).toContain('data-testid="desk-empty"');
    expect(html).toContain("Trip to Lisbon");
    expect(html).toContain('data-testid="desk-empty-new-tab"');
    expect(html).toContain("New tab");
    expect(html).toContain("Drop files here");
  });
});

describe("choosing spaces (main's commands)", () => {
  const commands: TabGroupCommand[] = [];
  beforeEach(() => {
    commands.length = 0;
    desktop({
      tabGroupCommand: (command: TabGroupCommand) => {
        commands.push(command);
        return Promise.resolve({ archivedEntryId: null });
      },
    });
  });
  afterEach(() => {
    useAppStore.setState({ snapshot: null });
    useDeskStore.setState({ saved: {} });
  });

  it("New space is an empty create, current at once", async () => {
    const id = await newSpace();
    expect(commands).toEqual([{ type: "create", id, tabIds: [], select: true }]);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/i);
  });

  it("tells a space chosen from a tab chosen: a space's row marks the passing (it comes up as left), any other choice reveals the tab", () => {
    useAppStore.setState({
      snapshot: {
        currentGroupId: "here",
        tabs: [
          { id: "a", lastActiveAt: 30 },
          { id: "b", lastActiveAt: 10 },
        ],
        tabGroups: [group("there", ["a", "b"])],
        looseGroups: [],
        anchorGroups: [],
      } as unknown as ShellSnapshot,
    });
    useDeskStore.setState({ saved: { there: { windows: [{ tabId: "b", rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, mini: { restore: { x: 0, y: 0, w: 0.5, h: 0.5 }, parked: true } }] } } });
    // Its row: main makes it current with b (the window left on top) in use — a space chosen, nothing revealed.
    selectSpace("there");
    const chosen = takeSpaceChoice("there", "b");
    expect(chosen).toBe(true);
    expect(revealFor("b", chosen)).toBe(false);
    // Read once.
    expect(takeSpaceChoice("there", "b")).toBe(false);
    // One of its tabs chosen instead (a row of it, the tab switcher, the palette): no mark, the tab's window comes out whole.
    expect(revealFor("a", takeSpaceChoice("there", "a"))).toBe(true);
    // The space chosen, but another of its tabs in use by the time main says so: that tab was chosen.
    selectSpace("there");
    expect(takeSpaceChoice("there", "a")).toBe(false);
    // A mark for one space says nothing of another's passing.
    selectSpace("there");
    expect(takeSpaceChoice("elsewhere", "b")).toBe(false);
    // Nothing in use, nothing to reveal.
    expect(revealFor(null, false)).toBe(false);
  });

  it("a space's row selects it, naming its window on top when it was left — or main's choice with none", () => {
    useAppStore.setState({
      snapshot: {
        currentGroupId: "here",
        tabs: [
          { id: "a", lastActiveAt: 30 },
          { id: "b", lastActiveAt: 10 },
        ],
        tabGroups: [group("there", ["a", "b"]), group("empty", [])],
        looseGroups: [],
        anchorGroups: [],
      } as unknown as ShellSnapshot,
    });
    useDeskStore.setState({ saved: { there: { windows: [{ tabId: "b", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] } } });
    selectSpace("there");
    selectSpace("empty");
    // The current one is not chosen again.
    selectSpace("here");
    expect(commands).toEqual([
      { type: "select", groupId: "there", tabId: "b" },
      { type: "select", groupId: "empty" },
    ]);
  });
});

describe("a row let go among the day's rows, beside an empty space (reorderDayTabs: docs/spaces.md §1)", () => {
  const H = 32;
  type Spec = Omit<MeasuredRow, "top" | "height">;
  const rows = (specs: Spec[]): MeasuredRow[] => specs.map((spec, i) => ({ ...spec, top: i * H, height: H }));
  const divider: Spec = { kind: "divider", entityId: "__new-tab", folderId: null };
  const tabRow = (id: string): Spec => ({ kind: "tab", entityId: id, folderId: null });
  const header = (id: string): Spec => ({ kind: "group", entityId: `group:${id}`, folderId: null, groupId: id });
  /** Just above row i's middle; just below it, past the header's middle half (which joins it). */
  const above = (i: number): number => i * H + 4;
  const below = (i: number): number => i * H + H - 4;
  const dayTab = (id: string) => ({ id, anchorId: null, lastActiveAt: 0 });

  let snapshot: ShellSnapshot;
  const reorders: unknown[][] = [];
  const commands: TabGroupCommand[] = [];
  /** What main does with a tab taken out of its space: `after` is the spaces then. */
  let afterRemove: TabGroupInfo[] | null = null;
  const bridge = {
    reorderTab: (...args: unknown[]) => {
      reorders.push(args);
      return Promise.resolve();
    },
    tabGroupCommand: (command: TabGroupCommand) => {
      commands.push(command);
      // (Main's snapshot precedes its reply.)
      if (command.type === "removeTab" && afterRemove !== null) useAppStore.setState({ snapshot: { ...snapshot, tabGroups: afterRemove } });
      return Promise.resolve({ archivedEntryId: null });
    },
  };
  const show = (tabGroups: TabGroupInfo[], tabIds = ["P", "T", "Q", "R"]): void => {
    snapshot = { tabs: tabIds.map(dayTab), tabGroups, splitGroups: [], anchorGroups: [], looseGroups: [] } as unknown as ShellSnapshot;
    useAppStore.setState({ snapshot });
  };
  beforeEach(() => {
    reorders.length = 0;
    commands.length = 0;
    afterRemove = null;
  });
  afterEach(() => {
    useAppStore.setState({ snapshot: null });
  });

  // T in hand, X empty and standing before T (where T's row was), Y empty before R. As drawn: P · X · Q · Y · R.
  const spaces = (): TabGroupInfo[] => [group("x", [], { beforeUnit: "T", createdAt: 1 }), group("y", [], { beforeUnit: "R", createdAt: 2 })];
  const list = rows([divider, tabRow("P"), header("x"), tabRow("Q"), header("y"), tabRow("R")]);

  it("counts the units as drawn, with T in hand: an empty space standing before T stays where it is drawn", () => {
    show(spaces());
    expect(dayUnitsInHand(snapshot, new Set(["T"])).map((unit) => unit.id)).toEqual(["P", "group:x", "Q", "group:y", "R"]);
  });

  it("on the desktop, hands main the unit index as drawn — just below an empty space is below it, just above one above it", async () => {
    desktop(bridge);
    show(spaces());
    const drops = [above(1), below(2), above(4), below(4)].map((y) => listDropAt(list, "tab", y, 0));
    expect(drops).toEqual([
      { zone: "today", index: 0 },
      { zone: "today", index: 2 },
      { zone: "today", index: 3 },
      { zone: "today", index: 4 },
    ]);
    for (const drop of drops) if (drop.zone === "today") await reorderDayTabs(["T"], drop.index);
    expect(reorders).toEqual([
      ["T", 0, "units"],
      ["T", 2, "units"],
      ["T", 3, "units"],
      ["T", 4, "units"],
    ]);
    expect(commands).toEqual([]);
  });

  it("counts again once the tab has left its space: a space it emptied that main let go of is no unit any more", async () => {
    desktop(bridge);
    // T the one tab of an auto space G: as drawn with T in hand, P · G · Q. Dropped just below G.
    show([group("g", ["T"], { origin: "auto" })], ["P", "T", "Q"]);
    const drop = listDropAt(rows([divider, tabRow("P"), header("g"), tabRow("Q")]), "tab", below(2), 0);
    expect(drop).toEqual({ zone: "today", index: 2 });
    afterRemove = [];
    await reorderDayTabs(["T"], 2);
    expect(commands).toEqual([{ type: "removeTab", tabId: "T" }]);
    expect(reorders).toEqual([["T", 1, "units"]]);
    // The person's space instead: kept, empty, where it stood (before Q) — still a unit, and T goes below it.
    reorders.length = 0;
    show([group("g", ["T"])], ["P", "T", "Q"]);
    afterRemove = [group("g", [], { beforeUnit: "Q" })];
    await reorderDayTabs(["T"], 2);
    expect(reorders).toEqual([["T", 2, "units"]]);
  });

  it("on the web, where the hosts count tabs, turns the unit into its first tab's place as before", async () => {
    web(bridge);
    show(spaces());
    // Just above R (below Y): R's place among the tabs without T.
    await reorderDayTabs(["T"], 4);
    expect(reorders).toEqual([["T", 2]]);
  });
});

describe("a favorite or pin let go on the current empty space's header (bringOutJoined)", () => {
  afterEach(() => {
    lendDeskEngine(null);
    useAppStore.setState({ snapshot: null });
  });

  it("brings its window out once its page has reached the space: the space's first tab, the drop not knowing it", async () => {
    desktop();
    const added: Array<[string, unknown]> = [];
    lendDeskEngine({ hasGroupTab: (tabId: string) => tabId === "page", add: (tabId: string, options: unknown) => added.push([tabId, options]) } as unknown as DeskEngine);
    useAppStore.setState({
      snapshot: { currentGroupId: "g", tabs: [{ id: "page", anchorId: null }], tabGroups: [group("g", ["page"])], looseGroups: [], anchorGroups: [] } as unknown as ShellSnapshot,
    });
    await bringOutJoined(null, "g");
    expect(added).toEqual([["page", { focus: true }]]);
    // Another space's header: nothing comes out (the desk shows the current one).
    await bringOutJoined(null, "elsewhere");
    expect(added).toHaveLength(1);
  });
});
