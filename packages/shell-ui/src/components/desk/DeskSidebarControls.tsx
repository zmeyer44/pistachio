/**
 * The desk's own controls in the sidebar, which is the desk's dock while a
 * desk is up (docs/desk.md): the switch between the whole sidebar and its
 * rail, the button for the desk's card (the arrangements, Feel, the way
 * out), and the group's context — its Stack — as a row under its tabs.
 * Each draws nothing without a desk.
 *
 * The cards they open are drawn by the desk, beside the button or row, over
 * its windows (DeskSurface's DeskSideCard): they meet through useDeskChrome.
 */

import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { AppWindow, ArrowUpToLine, Ellipsis, Maximize2, Minus, PanelLeftClose, PanelLeftOpen, PictureInPicture2 } from "lucide-react";
import { shortcutLabel, type ShortcutPlatform } from "@pistachio/shell-contracts/shortcuts";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { cn } from "../../lib/cn";
import { anchorOf, useDeskChrome, useDeskMark } from "../../lib/desk/chrome";
import { useDeskFileDrag } from "../../lib/desk/file-drag";
import { useGroupContexts } from "../../lib/desk/group-context";
import { deskEngine } from "../../lib/desk/open";
import { useDeskStore } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import type { MenuEntry } from "../ContextMenu";
import { useSidebarRail } from "../sidebar-rail";
import { carriesSomething, rejectionLine, takeDrop } from "./DeskStack";

const PLATFORM: ShortcutPlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";
/** The desk's card stays this long after the pointer leaves its button, to cross the gap to it (the dock's grace). */
const MORE_LINGER_MS = 300;
/** How long the context row bounces on taking something in. */
const RECEIVED_MS = 520;

let moreTimer = 0;

/** The pointer left the desk's button or its card: unless it comes back to one of them (or a click pinned it), the card goes. */
export function lingerDeskMore(): void {
  window.clearTimeout(moreTimer);
  moreTimer = window.setTimeout(() => {
    const card = useDeskChrome.getState().card;
    if (card?.kind !== "more" || card.pinned) return;
    if (document.querySelector("[data-testid='desk-more']:hover, [data-testid='desk-more-card']:hover") !== null) return;
    useDeskChrome.getState().closeCard("more");
  }, MORE_LINGER_MS);
}

/** The pointer came back to the desk's button or its card: it stays. */
export function holdDeskMore(): void {
  window.clearTimeout(moreTimer);
}

function useDeskUp(): boolean {
  return useDeskStore((state) => state.groupId !== null && !state.leaving);
}

/** The whole sidebar, or its rail (⌘S on a desk). */
export function DeskRailToggle({ className }: { className?: string }) {
  const up = useDeskStore((state) => state.groupId !== null || state.opening !== null);
  const rail = useDeskStore((state) => state.rail);
  const hint = useAppStore((state) => shortcutLabel(state.settings.shortcuts.toggleSidebarPinned, PLATFORM));
  if (!up) return null;
  const label = rail ? "Show the whole sidebar" : "Collapse the sidebar to a rail";
  return (
    <button
      type="button"
      aria-label={label}
      title={hint === null ? label : `${label} (${hint})`}
      data-testid="desk-rail-toggle"
      aria-pressed={!rail}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => useDeskStore.getState().setRail(!rail)}
      className={cn("desk-side-button no-drag", className)}
    >
      {rail ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
    </button>
  );
}

/**
 * The desk's card: the arrangements, the variants (Feel), and Leave the
 * desk. The pointer on it brings the card up beside it; a click pins it up
 * until a press anywhere else or Escape.
 */
export function DeskMoreButton({ className }: { className?: string }) {
  const up = useDeskUp();
  const open = useDeskChrome((state) => state.card?.kind === "more");
  const pinned = useDeskChrome((state) => state.card?.kind === "more" && state.card.pinned);
  const ref = useRef<HTMLButtonElement>(null);
  if (!up) return null;
  const show = (pin: boolean): void => {
    holdDeskMore();
    const el = ref.current;
    if (el === null) return;
    const current = useDeskChrome.getState().card;
    useDeskChrome.getState().openCard({ kind: "more", anchor: anchorOf(el), pinned: pin || (current?.kind === "more" && current.pinned) });
  };
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Desk: arrange, feel, leave"
      title="Desk: arrange, feel, leave"
      aria-expanded={open}
      aria-pressed={open}
      data-testid="desk-more"
      // A press leaves the keyboard where it was (a window's page).
      onMouseDown={(event) => event.preventDefault()}
      onPointerEnter={() => show(false)}
      onPointerLeave={lingerDeskMore}
      onClick={() => (pinned ? useDeskChrome.getState().closeCard("more") : show(true))}
      className={cn("desk-side-button no-drag", className)}
    >
      <Ellipsis aria-hidden="true" />
    </button>
  );
}

/**
 * The group's context (docs/desk-agent.md §1, "The Stack"), as the last row
 * under the desk's group in the sidebar: a pile of sheets and how many things
 * it holds. Files dropped on it (and text or links dragged out of a page) go
 * into the context; a click opens its card beside it. It is the documents'
 * home on the desk (DeskSurface's host finds it): their windows are put away
 * into it and come out of it, and it bounces when something comes in.
 */
export function DeskContextRow({ group }: { group: TabGroupInfo }) {
  const rail = useSidebarRail();
  const contexts = useGroupContexts();
  const count = contexts.find((candidate) => candidate.groupId === group.id)?.items.length ?? 0;
  const open = useDeskChrome((state) => state.card?.kind === "stack");
  const fileDrag = useDeskFileDrag((state) => state.active);
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);
  const ref = useRef<HTMLDivElement>(null);
  const before = useRef(count);
  useEffect(() => {
    const grew = count > before.current;
    before.current = count;
    const el = ref.current;
    if (!grew || el === null) return;
    delete el.dataset["received"];
    void el.offsetWidth;
    el.dataset["received"] = "";
    const timer = window.setTimeout(() => delete el.dataset["received"], RECEIVED_MS);
    return () => window.clearTimeout(timer);
  }, [count]);
  const say = (line: string | null): void => {
    if (line === null) return;
    // What could not be taken is said on the card: it opens to say so.
    const el = ref.current;
    if (el !== null) useDeskChrome.getState().openCard({ kind: "stack", anchor: anchorOf(el), pinned: true, rejection: line });
  };
  const toggle = (): void => {
    const el = ref.current;
    if (el === null) return;
    if (open) useDeskChrome.getState().closeCard("stack");
    else useDeskChrome.getState().openCard({ kind: "stack", anchor: anchorOf(el), pinned: true });
  };
  const label = count === 0 ? "Context: drop files here" : `Context: ${String(count)} ${count === 1 ? "thing" : "things"}`;
  const onDragEnter = (event: ReactDragEvent): void => {
    if (!carriesSomething(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDropping(true);
  };
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-expanded={open}
      title={label}
      data-testid="desk-stack"
      data-count={count}
      data-open={open ? "" : undefined}
      data-dropping={dropping ? "" : undefined}
      data-drop-target={fileDrag && !dropping ? "" : undefined}
      className={cn("desk-context-row no-drag", rail && "desk-context-row-rail")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        if (!carriesSomething(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDropping(false);
      }}
      onDrop={(event) => {
        if (!carriesSomething(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDropping(false);
        void takeDrop(group, event.dataTransfer).then((result) => say(rejectionLine(result)), () => say("That could not be added"));
      }}
    >
      <span className="desk-context-pile" aria-hidden="true">
        <span className="desk-context-sheet" data-layer="2" />
        <span className="desk-context-sheet" data-layer="1" />
        {count === 0 ? null : <span className="desk-context-count">{count}</span>}
      </span>
      <span className="desk-context-label">Context</span>
      <span className="desk-context-meta">{count === 0 ? "Drop files" : count}</span>
    </div>
  );
}

/**
 * A tab's row marks its window on the desk, as the Dock marks a running app:
 * a dot at the row's leading edge while its window is out, a longer one in
 * the group's colour for the window in use. Nothing without a desk.
 */
export function DeskRowMark({ tabId }: { tabId: string }) {
  const mark = useDeskMark(tabId);
  if (mark === null) return null;
  return <span aria-hidden="true" data-testid="desk-row-mark" data-mark={mark} className="desk-row-mark" />;
}

/** The pointer came to a tab's row, or left it: while a desk is up, ⇧⌫ closes the tab whose row it is on. */
export function hoverDeskRow(tabId: string, inside: boolean): void {
  const chrome = useDeskChrome.getState();
  if (inside) {
    if (useDeskStore.getState().groupId !== null) chrome.setHovered(tabId);
  } else if (chrome.hovered === tabId) chrome.setHovered(null);
}

/**
 * What the desk does with a tab's window, first on its row's menu while the
 * tab is the desk's: out onto the desk, to the front, minimized or put away.
 * Nothing for any other tab, or without a desk.
 */
export function deskTabEntries(tabId: string): MenuEntry[] {
  const engine = deskEngine();
  if (engine === null || !engine.hasGroupTab(tabId)) return [];
  const out = engine.getView().windows.find((window) => window.tabId === tabId && window.flight !== "away");
  const entries: MenuEntry[] =
    out === undefined
      ? [{ label: "Open on the desk", icon: <AppWindow aria-hidden="true" />, onSelect: () => engine.add(tabId, { focus: true }) }]
      : out.mini !== null
        ? [
            { label: "Expand", icon: <Maximize2 aria-hidden="true" />, onSelect: () => engine.expand(tabId) },
            { label: "Collapse into the sidebar", icon: <Minus aria-hidden="true" />, onSelect: () => engine.putAway(tabId) },
          ]
        : [
            ...(out.focused ? [] : [{ label: "Bring to front", icon: <ArrowUpToLine aria-hidden="true" />, onSelect: () => engine.add(tabId, { focus: true }) }]),
            // (A masked window is a picture of part of its page: it is not minimized.)
            ...(out.mask !== null ? [] : [{ label: "Minimize", icon: <PictureInPicture2 aria-hidden="true" />, onSelect: () => engine.minimize(tabId) }]),
            { label: "Collapse into the sidebar", icon: <Minus aria-hidden="true" />, onSelect: () => engine.putAway(tabId) },
          ];
  return [...entries, { separator: true }];
}
