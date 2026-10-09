/**
 * Main's questions about the desk (docs/desk-agent.md §3): the agent's desk
 * tools and a tab it opened, answered from the engine as the desk stands
 * now. Apart from DeskSurface, which feeds it the browser's tabs and keeps
 * the notes and the Undo layout, so the answers can be tested without React.
 */

import { MAX_DESK_DOCKED, MAX_DESK_TITLE, MAX_DESK_URL, type DeskAgentState, type DeskReply, type DeskRequest } from "@pistachio/shell-contracts/desk-agent";
import { displayHost } from "../../lib/url";
import { fileItemOf } from "../../lib/desk/windows";
import type { DeskEngine, DeskLayoutSnapshot } from "./desk-engine";

/** A tab the agent opened reaches the shell's group a moment after main put it there: this long, at most. */
export const JOIN_WAIT_MS = 2_000;

export interface DeskAnswerDeps {
  engine: Pick<DeskEngine, "agentLayout" | "arrangeFor" | "bringOutQuietly" | "hasGroupTab" | "layoutSnapshot" | "windowTabIds">;
  /** The group whose windows the engine shows now. */
  groupId(): string;
  /** That group's name. */
  title(): string;
  tab(tabId: string): { title: string; url: string } | undefined;
  /** A document window's file (its context item). */
  file(itemId: string): { name: string } | undefined;
  /** The open run's turn, which a layout remembered for Undo belongs to; null with none. */
  turn(): { runId: string; turns: number } | null;
  /** Where every window was before the agent first moved one in this turn (the first call per turn wins). */
  remember(turn: { runId: string; turns: number }, layout: DeskLayoutSnapshot): void;
  /** A note on a window's frame, or none. */
  note(tabId: string, text: string | null): void;
  wait?(ms: number): Promise<void>;
}

/** Within `max` characters: a page's title or address may be any length, and a reply that carries more is refused whole. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The desk as the agent reads it, within the bounds main accepts (isDeskAgentState). */
export function deskStateOf(deps: DeskAnswerDeps): DeskAgentState {
  const layout = deps.engine.agentLayout();
  const describe = (tabId: string): { title: string; url: string } => {
    const itemId = fileItemOf(tabId);
    if (itemId !== null) return { title: clip(deps.file(itemId)?.name ?? "Document", MAX_DESK_TITLE), url: "" };
    const tab = deps.tab(tabId);
    return { title: clip(tab?.title || displayHost(tab?.url ?? "") || "Untitled", MAX_DESK_TITLE), url: clip(tab?.url ?? "", MAX_DESK_URL) };
  };
  return {
    groupId: deps.groupId(),
    title: clip(deps.title(), MAX_DESK_TITLE),
    windows: layout.windows.map((window) => ({ tabId: window.tabId, kind: window.kind, ...describe(window.tabId), box: window.box, focused: window.focused, masked: window.masked, minimized: window.minimized })),
    docked: layout.docked.slice(0, MAX_DESK_DOCKED).map((tabId) => ({ tabId, ...describe(tabId) })),
  };
}

export async function answerDeskRequest(deps: DeskAnswerDeps, request: DeskRequest): Promise<DeskReply> {
  const { engine } = deps;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
  /** Before the agent first moves a window in a turn: where every window was. */
  const remember = (layout: DeskLayoutSnapshot = engine.layoutSnapshot()): void => {
    const turn = deps.turn();
    if (turn !== null) deps.remember(turn, layout);
  };
  // Meant for a desk no longer in view (passed to another group mid-turn): refused before anything moves.
  if (request.groupId !== deps.groupId()) return { ok: false, error: "the desk in view is another space's now; nothing was changed" };
  switch (request.type) {
    case "state":
      return { ok: true, state: deskStateOf(deps) };
    case "arrange": {
      const layout = engine.layoutSnapshot();
      const error = engine.arrangeFor(request.plan);
      if (error !== null) return { ok: false, error };
      remember(layout);
      return { ok: true, state: deskStateOf(deps) };
    }
    case "bringOut": {
      for (let waited = 0; !engine.hasGroupTab(request.tabId) && waited < JOIN_WAIT_MS; waited += 100) await wait(100);
      if (!engine.hasGroupTab(request.tabId)) return { ok: false, error: "that tab is not on this desk" };
      if (!engine.windowTabIds().includes(request.tabId)) {
        remember();
        engine.bringOutQuietly(request.tabId);
      }
      return { ok: true, state: deskStateOf(deps) };
    }
    case "note": {
      if (!engine.windowTabIds().includes(request.tabId))
        return { ok: false, error: fileItemOf(request.tabId) === null ? "that tab is in the dock: bring it out with desk_arrange first" : "that document is not open on the desk: bring it out with desk_arrange first" };
      const text = request.text?.trim() ?? "";
      deps.note(request.tabId, text === "" ? null : text.slice(0, 80));
      return { ok: true, state: deskStateOf(deps) };
    }
  }
}
