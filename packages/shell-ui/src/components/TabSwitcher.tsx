import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { TabSwitcherPreview } from "@pistachio/shell-contracts/ipc";
import { TAB_SWITCHER_LIMIT, tabSwitcherHeld, tabSwitcherIndex } from "@pistachio/shell-contracts/tab-switcher";
import { cn } from "../lib/cn";
import { TAB_SWITCHER_GAP, TAB_SWITCHER_PADDING, tabSwitcherGrid } from "../lib/tab-switcher-grid";
import { displayHost } from "../lib/url";
import { useAppStore } from "../store";
import { TabMark } from "./Favicon";
import { shellApi } from "../api";

const EMPTY_GROUPS: TabGroupInfo[] = [];
/** Keys the open switcher owns in the shell's document: none may move focus or press a button under it. */
const OWNED_KEYS = new Set(["Tab", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** How many cards the window has room for right now. */
function capacityNow(): number {
  return Math.min(TAB_SWITCHER_LIMIT, tabSwitcherGrid(window.innerWidth, window.innerHeight, TAB_SWITCHER_LIMIT).capacity);
}

/**
 * The tab switcher: ⌥⌘ or ⌥⌃ held (or ⌃Tab) shows the Space's tabs as live
 * thumbnails, most recently visited first, in the address modal's material.
 * Main reads the gesture from whichever view has the keyboard and owns the
 * order and the captures; this shell owns the selection and the drawing.
 */
export function TabSwitcher() {
  const session = useAppStore((state) => state.tabSwitcher);
  const overlay = useAppStore((state) => state.overlay);
  const overlayReady = useAppStore((state) => state.overlayReady);
  const groups = useAppStore((state) => state.snapshot?.tabGroups ?? EMPTY_GROUPS);
  const tabCount = useAppStore((state) => state.snapshot?.tabs.filter((tab) => !tab.unlisted).length ?? 0);
  const setIndex = useAppStore((state) => state.setTabSwitcherIndex);
  const finish = useAppStore((state) => state.finishTabSwitcher);
  const viewport = useViewport();

  const loading = session?.loading ?? true;
  const previews = session?.previews ?? [];
  const capacity = Math.min(TAB_SWITCHER_LIMIT, tabSwitcherGrid(viewport.width, viewport.height, TAB_SWITCHER_LIMIT).capacity);
  const count = loading ? Math.max(2, Math.min(capacity, tabCount)) : Math.min(capacity, previews.length);
  const grid = tabSwitcherGrid(viewport.width, viewport.height, count);
  const columnsRef = useRef(grid.columns);
  columnsRef.current = grid.columns;

  useEffect(
    () =>
      shellApi().onTabSwitcherInput((input) => {
        const state = useAppStore.getState();
        switch (input.type) {
          case "open":
            void state.openTabSwitcher(input.modifier, input.step, capacityNow());
            return;
          case "step":
            if (state.tabSwitcher === null || state.tabSwitcher.finishing)
              void state.openTabSwitcher("control", input.reverse ? -1 : 1, capacityNow());
            else state.stepTabSwitcher(input.reverse);
            return;
          case "move":
            state.moveTabSwitcher(input.direction, columnsRef.current);
            return;
          case "commit":
            void state.finishTabSwitcher(true);
            return;
          case "cancel":
            void state.finishTabSwitcher(false);
            return;
        }
      }),
    [],
  );
  useEffect(() => shellApi().onTabSwitcherThumbnail((thumbnail) => useAppStore.getState().setTabSwitcherThumbnail(thumbnail)), []);

  // Main moves the keyboard here as the switcher opens and reads the keys
  // itself; the document must only keep them from its own focus and buttons.
  // The modifier flags double-check the release main may not have seen.
  const active = session !== null;
  const modifier = session?.modifier ?? "control";
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (OWNED_KEYS.has(event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
      const held = tabSwitcherHeld(modifier, { control: event.ctrlKey, meta: event.metaKey, alt: event.altKey });
      if (!held && event.key !== "Escape") void useAppStore.getState().finishTabSwitcher(true);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [active, modifier]);

  // Something else took the overlay (⌘T went on to open the address bar).
  const revealed = session?.revealed === true;
  useEffect(() => {
    if (revealed && overlay !== "tab-switcher") void useAppStore.getState().finishTabSwitcher(false);
  }, [revealed, overlay]);

  // Chromium replays a resting pointer as moves when the layout under it
  // changes; only a pointer that really moved picks a card, so the switcher
  // opens on the active tab wherever the pointer happens to rest.
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const serial = session?.serial ?? null;
  useEffect(() => {
    pointerAt.current = null;
  }, [serial]);
  const pointerMoved = (event: ReactPointerEvent): boolean => {
    const last = pointerAt.current;
    pointerAt.current = { x: event.screenX, y: event.screenY };
    return last !== null && (last.x !== event.screenX || last.y !== event.screenY);
  };

  const groupOf = useMemo(() => {
    const byTab = new Map<string, TabGroupInfo>();
    for (const group of groups) for (const tabId of group.tabIds) byTab.set(tabId, group);
    return byTab;
  }, [groups]);

  if (session === null || !revealed || overlay !== "tab-switcher") return null;

  const shown = previews.slice(0, count);
  const selected = tabSwitcherIndex(session.offset, shown.length);
  const selectedPreview = loading ? undefined : shown[selected];
  const releaseCheck = (event: ReactPointerEvent) => {
    // The pointer carries the modifier state too: a release main never saw ends it here.
    if (!tabSwitcherHeld(modifier, { control: event.ctrlKey, meta: event.metaKey, alt: event.altKey })) void finish(true);
  };

  return (
    <div
      className={cn("no-drag fixed inset-0 z-40 grid place-items-center", !overlayReady && "pointer-events-none opacity-0")}
      data-testid="tab-switcher"
      data-ready={overlayReady ? "" : undefined}
      onPointerDown={() => void finish(false)}
      onPointerMove={releaseCheck}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* The scrim is the panel's sibling, as under the address modal: a
          backdrop root would leave the panel's blur nothing to blur. */}
      <div aria-hidden="true" className={cn("veil absolute inset-0", overlayReady && "animate-backdrop-in")} />
      <div
        role="dialog"
        aria-label="Switch tabs"
        className={cn("palette-surface relative overflow-hidden rounded-[28px] shadow-modal", overlayReady && "animate-overlay-in")}
        style={{ width: grid.panelWidth, padding: TAB_SWITCHER_PADDING }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          role="listbox"
          aria-label="Recently visited tabs"
          aria-activedescendant={selectedPreview === undefined ? undefined : optionId(selectedPreview)}
          className="flex flex-wrap justify-center"
          style={{ gap: TAB_SWITCHER_GAP }}
        >
          {loading
            ? Array.from({ length: count }, (_, index) => <CardSkeleton key={index} width={grid.cardWidth} />)
            : shown.map((preview, index) => (
                <TabCard
                  key={preview.tab.id}
                  preview={preview}
                  group={groupOf.get(preview.tab.id) ?? null}
                  width={grid.cardWidth}
                  selected={index === selected}
                  onPointerMove={(event) => {
                    if (pointerMoved(event) && index !== selected) setIndex(index);
                  }}
                  onChoose={() => void finish(true, preview.tab.id)}
                />
              ))}
        </div>
        <p className="sr-only" aria-live="polite">
          {selectedPreview === undefined ? "" : `${titleOf(selectedPreview)}, ${selected + 1} of ${shown.length}`}
        </p>
      </div>
    </div>
  );
}

function optionId(preview: TabSwitcherPreview): string {
  return `tab-switcher-${preview.tab.id}`;
}

function titleOf(preview: TabSwitcherPreview): string {
  return preview.tab.title || displayHost(preview.tab.url) || "New tab";
}

function TabCard({
  preview,
  group,
  width,
  selected,
  onPointerMove,
  onChoose,
}: {
  preview: TabSwitcherPreview;
  group: TabGroupInfo | null;
  width: number;
  selected: boolean;
  onPointerMove: (event: ReactPointerEvent) => void;
  onChoose: () => void;
}) {
  const host = displayHost(preview.tab.url);
  return (
    <div
      id={optionId(preview)}
      role="option"
      aria-selected={selected}
      aria-label={titleOf(preview)}
      data-testid="tab-switcher-option"
      data-tab-id={preview.tab.id}
      className={cn("flex min-w-0 flex-col rounded-[18px] p-2 transition-colors duration-100", selected && "bg-alpha-200")}
      style={{ width }}
      onPointerMove={onPointerMove}
      // Down rather than click: ⌃-click is a right-click on a Mac.
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onChoose();
      }}
    >
      <span className="tab-switcher-thumbnail relative block aspect-[16/10] w-full overflow-hidden rounded-[12px] bg-background-100">
        {preview.dataUrl === null ? (
          <span className="tab-switcher-fallback absolute inset-0 grid place-content-center justify-items-center gap-2 text-[11px] text-gray-800">
            <TabMark tab={preview.tab} className="size-7 rounded-[7px] text-[13px]" />
            <span className="max-w-[80%] truncate">{host || titleOf(preview)}</span>
          </span>
        ) : (
          <img src={preview.dataUrl} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
        )}
        {group === null ? null : (
          <span
            data-group-color={group.color}
            className="tab-group-tone absolute top-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1.5 rounded-[7px] bg-black/75 px-2 py-[3px] text-[11.5px] leading-4 font-medium text-white"
          >
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-(--tg-solid)" />
            <span className="truncate">{group.title}</span>
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2 px-1 pt-2 pb-0.5">
        <TabMark tab={preview.tab} className="size-4 rounded-[4px] text-[9px]" />
        <span className={cn("min-w-0 truncate text-[13px] font-medium", selected ? "text-gray-1000" : "text-gray-900")}>
          {titleOf(preview)}
        </span>
      </span>
    </div>
  );
}

function CardSkeleton({ width }: { width: number }) {
  return (
    <div className="tab-switcher-skeleton flex flex-col rounded-[18px] p-2" style={{ width }} aria-hidden="true">
      <span className="block aspect-[16/10] w-full rounded-[12px]" />
      <span className="flex items-center gap-2 px-1 pt-2 pb-0.5">
        <span className="size-4 rounded-[4px]" />
        <span className="h-3 w-3/5 rounded-full" />
      </span>
    </div>
  );
}
