/**
 * The sidebar's three modes (docs/spaces.md §3, since 2026-10-09): whole, a
 * rail of its icons, or hidden at the window's left edge — one setting. ⌘S
 * cycles them (whole ⇄ hidden on the web, where the rail is not offered and a
 * stored rail is drawn whole); the action names where it goes; main hears the
 * column is on screen only once it is (hidden on the desk: once it is OUT
 * over the desk, its cover clear, never on the intent alone); the overlaid
 * column's life — out, going, left — runs render by render; and what the
 * sidebar lays over the desk is a cover the desk's live pages give way to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SURFACE_MEMBERS } from "@pistachio/shell-contracts/ipc";
import { DEFAULT_SETTINGS, type SidebarMode } from "@pistachio/shell-contracts/settings";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { CHROME_ACTIONS, type ActionContext } from "../src/chrome/actions";
import { runShellCommand, shellStateOf } from "../src/chrome/shell-host";
import { useDeskChrome, watchDeskCover, type DeskCoverHost } from "../src/lib/desk/chrome";
import {
  nextSidebarOverlay,
  SIDEBAR_OVERLAY_AWAY,
  sidebarCoverWanted,
  sidebarHeld,
  sidebarModeOf,
  sidebarOnScreen,
  useSidebarColumn,
  type SidebarOverlay,
} from "../src/lib/sidebar-mode";
import { readPersistedDesk, useDeskStore } from "../src/lib/desk/store";
import { useAppStore } from "../src/store";

/** A bridge with every native member: the desktop, where the desk is (and the rail). */
function desktop(): void {
  setShellApi({
    ...Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()])),
    updateSettings: () => new Promise(() => undefined),
  } as unknown as ShellApiBridge);
}

/** The web's stream surface: no native members. */
function web(): void {
  setShellApi({ updateSettings: () => new Promise(() => undefined) } as unknown as ShellApiBridge);
}

function stored(sidebar: SidebarMode, revealed = false): void {
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, layout: { ...DEFAULT_SETTINGS.layout, sidebar } }, sidebarRevealed: revealed });
}

const mode = (): SidebarMode => useAppStore.getState().settings.layout.sidebar;

beforeEach(() => {
  useSidebarColumn.setState({ out: false, renaming: false });
  stored("whole");
});

afterEach(() => {
  setShellApi({} as unknown as ShellApiBridge);
});

describe("the mode as drawn", () => {
  it("keeps a rail on the desktop, and draws a stored one whole on the web without rewriting it", () => {
    desktop();
    expect(sidebarModeOf({ layout: { sidebar: "rail" } })).toBe("rail");
    web();
    expect(sidebarModeOf({ layout: { sidebar: "rail" } })).toBe("whole");
    expect(sidebarModeOf({ layout: { sidebar: "hidden" } })).toBe("hidden");
  });
});

describe("⌘S and the buttons", () => {
  it("cycles whole → rail → hidden → whole on the desktop, the column put away at once going hidden", () => {
    desktop();
    runShellCommand({ type: "toggleSidebarPinned" });
    expect(mode()).toBe("rail");
    useAppStore.setState({ sidebarRevealed: true });
    runShellCommand({ type: "toggleSidebarPinned" });
    expect(mode()).toBe("hidden");
    expect(useAppStore.getState().sidebarRevealed).toBe(false);
    runShellCommand({ type: "toggleSidebarPinned" });
    expect(mode()).toBe("whole");
  });

  it("goes whole ⇄ hidden on the web — from a stored rail too, drawn whole there", () => {
    web();
    runShellCommand({ type: "toggleSidebarPinned" });
    expect(mode()).toBe("hidden");
    runShellCommand({ type: "toggleSidebarPinned" });
    expect(mode()).toBe("whole");
    stored("rail");
    runShellCommand({ type: "toggleSidebarPinned" });
    expect(mode()).toBe("hidden");
  });

  it("sets a mode outright (a column's button, Settings › General)", () => {
    desktop();
    stored("hidden", true);
    runShellCommand({ type: "setSidebarMode", mode: "whole" });
    expect(mode()).toBe("whole");
    runShellCommand({ type: "setSidebarMode", mode: "rail" });
    expect(mode()).toBe("rail");
    useAppStore.setState({ sidebarRevealed: true });
    runShellCommand({ type: "setSidebarMode", mode: "hidden" });
    expect(mode()).toBe("hidden");
    expect(useAppStore.getState().sidebarRevealed).toBe(false);
  });

  it("names the step it takes, by where it goes", () => {
    const label = (sidebar: SidebarMode): string =>
      CHROME_ACTIONS.toggleSidebarPinned.label({ settings: { ...DEFAULT_SETTINGS, layout: { sidebar } } } as unknown as ActionContext);
    desktop();
    expect(label("whole")).toBe("Collapse sidebar to a rail");
    expect(label("rail")).toBe("Hide sidebar");
    expect(label("hidden")).toBe("Show the whole sidebar");
    web();
    expect(label("whole")).toBe("Hide sidebar");
    expect(label("rail")).toBe("Hide sidebar");
    expect(label("hidden")).toBe("Show the whole sidebar");
  });
});

describe("what main hears (ShellState)", () => {
  it("says whole and rail are on screen, and the rail is the rail, only on the desktop", () => {
    desktop();
    stored("whole");
    expect(shellStateOf(useAppStore.getState())).toMatchObject({ sidebarRevealed: true, sidebarRail: false });
    stored("rail");
    expect(shellStateOf(useAppStore.getState())).toMatchObject({ sidebarRevealed: true, sidebarRail: true });
    web();
    expect(shellStateOf(useAppStore.getState())).toMatchObject({ sidebarRevealed: true, sidebarRail: false });
  });

  it("says the hidden column is on screen over the desk only once it is out, never on the intent", () => {
    desktop();
    stored("hidden", true);
    expect(shellStateOf(useAppStore.getState()).sidebarRevealed).toBe(false);
    useSidebarColumn.getState().setOut(true);
    expect(shellStateOf(useAppStore.getState()).sidebarRevealed).toBe(true);
    useSidebarColumn.getState().setOut(false);
    expect(shellStateOf(useAppStore.getState()).sidebarRevealed).toBe(false);
  });

  it("says the hidden column is on screen on the web as soon as it is brought out (it reflows the page)", () => {
    web();
    stored("hidden", false);
    expect(shellStateOf(useAppStore.getState()).sidebarRevealed).toBe(false);
    stored("hidden", true);
    expect(shellStateOf(useAppStore.getState()).sidebarRevealed).toBe(true);
  });

  it("reads the same in the pure rule", () => {
    expect(sidebarOnScreen("whole", false, false, false)).toBe(true);
    expect(sidebarOnScreen("rail", false, false, false)).toBe(true);
    expect(sidebarOnScreen("hidden", true, true, false)).toBe(false);
    expect(sidebarOnScreen("hidden", true, true, true)).toBe(true);
    expect(sidebarOnScreen("hidden", false, true, false)).toBe(true);
  });
});

describe("the overlaid column's life (hidden, on the desk)", () => {
  /** One render: the state the column settles at, as React's derived-state step would reach it. */
  const render = (state: SidebarOverlay, overlay: boolean, revealed: boolean, clear: boolean): SidebarOverlay => nextSidebarOverlay(state, overlay, revealed, clear);

  it("puts its cover up as the pointer comes, and slides in only once the windows under it have given way", () => {
    let state = SIDEBAR_OVERLAY_AWAY;
    expect(sidebarCoverWanted(state, true, false)).toBe(false);
    // The pointer arrives: the cover goes up, the column waits.
    expect(sidebarCoverWanted(state, true, true)).toBe(true);
    state = render(state, true, true, false);
    expect(state.out).toBe(false);
    // The stills are in.
    state = render(state, true, true, true);
    expect(state).toEqual({ out: true, retreating: false, leaving: false });
    // Nothing changed: the same state, so a render does not set it again.
    expect(render(state, true, true, true)).toBe(state);
  });

  it("stays out while it is wanted, its cover not clear for a moment (a window landing under it): only the intent going sends it back", () => {
    const out: SidebarOverlay = { out: true, retreating: false, leaving: false };
    // A space chosen from the column: a window lands under it before its still is up.
    expect(render(out, true, true, false)).toBe(out);
    // The pointer goes: now it retreats, cover clear or not.
    expect(render(out, true, false, false)).toEqual({ out: false, retreating: true, leaving: false });
    expect(render(out, true, false, true)).toEqual({ out: false, retreating: true, leaving: false });
    // Coming back during the retreat, it waits for its cover again before it is in.
    expect(render({ out: false, retreating: true, leaving: false }, true, true, false)).toEqual({ out: false, retreating: true, leaving: false });
  });

  it("calls the reveal off without a retreat when the pointer goes before the stills are in", () => {
    let state = render(SIDEBAR_OVERLAY_AWAY, true, true, false);
    state = render(state, true, false, false);
    expect(state).toEqual(SIDEBAR_OVERLAY_AWAY);
    expect(sidebarCoverWanted(state, true, false)).toBe(false);
  });

  it("keeps its cover through the retreat, and comes straight back if the pointer does", () => {
    let state: SidebarOverlay = { out: true, retreating: false, leaving: false };
    state = render(state, true, false, true);
    expect(state).toEqual({ out: false, retreating: true, leaving: false });
    expect(sidebarCoverWanted(state, true, false)).toBe(true);
    // Back before the retreat ends: the cover never came down, so it is out again at once.
    expect(render(state, true, true, true)).toEqual({ out: true, retreating: false, leaving: false });
    // The retreat ended (the pane's transitionend): the cover comes down.
    expect(sidebarCoverWanted({ ...state, retreating: false }, true, false)).toBe(false);
  });

  it("keeps its cover while the slot grows out from under it, a mode left while it was out (⌘S → whole)", () => {
    const out: SidebarOverlay = { out: true, retreating: false, leaving: false };
    const left = render(out, false, true, true);
    expect(left).toEqual({ out: false, retreating: false, leaving: true });
    expect(sidebarCoverWanted(left, false, false)).toBe(true);
    // Left while going, the same.
    expect(render({ out: false, retreating: true, leaving: false }, false, false, true).leaving).toBe(true);
    // Left from away, nothing to keep: the slot and the pane slide together.
    expect(render(SIDEBAR_OVERLAY_AWAY, false, false, false)).toBe(SIDEBAR_OVERLAY_AWAY);
  });

  it("is held out by what reaches past it: a resize, a row dragged, a card or a context menu it opened, a rename", () => {
    const quiet = { paneResizing: false, tabDragging: false, overlay: "none" as const };
    expect(sidebarHeld(quiet, false, false)).toBe(false);
    expect(sidebarHeld({ ...quiet, paneResizing: true }, false, false)).toBe(true);
    expect(sidebarHeld({ ...quiet, tabDragging: true }, false, false)).toBe(true);
    expect(sidebarHeld({ ...quiet, overlay: "context-menu" }, false, false)).toBe(true);
    expect(sidebarHeld(quiet, true, false)).toBe(true);
    expect(sidebarHeld(quiet, false, true)).toBe(true);
    // (The desk's card and the rename are the stores': lib/desk/chrome.ts, lib/sidebar-mode.ts.)
    expect(useDeskChrome.getState().card).toBe(null);
  });
});

describe("a cover over the desk from the sidebar (useDeskCover's watch)", () => {
  function stubEngine() {
    const covers = new Map<string, unknown>();
    const listeners = new Set<() => void>();
    const view = { gesture: null as string | null, clearCovers: new Set<string>() as ReadonlySet<string> };
    const engine: DeskCoverHost = {
      setCover: (key, rect) => (rect === null ? covers.delete(key) : covers.set(key, rect)),
      getView: () => view,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emit = (): void => {
      for (const listener of listeners) listener();
    };
    return { engine, covers, listeners, view, emit };
  }

  it("goes up where it is measured, says when the live pages under it have given way, and comes down when disposed", () => {
    const { engine, covers, listeners, view, emit } = stubEngine();
    const clear = vi.fn();
    const gesture = vi.fn();
    let box = { x: -10, y: 0, w: 264, h: 900 };
    const watch = watchDeskCover(engine, "sidebar", () => box, { clear, gesture });
    expect(covers.get("sidebar")).toEqual(box);
    expect(clear).toHaveBeenLastCalledWith(false);
    view.clearCovers = new Set(["sidebar"]);
    emit();
    expect(clear).toHaveBeenLastCalledWith(true);
    // The stage moved under it (a mode changed): measured again.
    box = { x: -120, y: 0, w: 264, h: 900 };
    watch.measure();
    expect(covers.get("sidebar")).toEqual(box);
    watch.dispose();
    expect(covers.has("sidebar")).toBe(false);
    expect(listeners.size).toBe(0);
    expect(gesture).not.toHaveBeenCalled();
  });

  it("goes when a window is taken in hand", () => {
    const { engine, view, emit } = stubEngine();
    const gesture = vi.fn();
    const watch = watchDeskCover(engine, "favorites", () => ({ x: 0, y: 0, w: 10, h: 10 }), { clear: vi.fn(), gesture });
    view.gesture = "move";
    emit();
    expect(gesture).toHaveBeenCalledTimes(1);
    watch.dispose();
  });
});

describe("the desk's own state", () => {
  it("no longer keeps the rail: a stored one is ignored, and none is written", () => {
    const read = readPersistedDesk(JSON.stringify({ version: 2, rail: false, variants: {}, saved: {} }));
    expect("rail" in read).toBe(false);
    expect("rail" in useDeskStore.getState()).toBe(false);
  });
});
