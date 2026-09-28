import { memo, useCallback, useState } from "react";
import { ChevronDown, ChevronsUpDown, Layers2, LayoutGrid, Sparkles, X } from "lucide-react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { cn } from "../../lib/cn";
import { DESK_AXES, useDeskStore, type DeskVariants } from "../../lib/desk/store";
import { displayHost } from "../../lib/url";
import { Favicon } from "../Favicon";
import { RAIL_W, type DeskEngine, type DeskView } from "./desk-engine";

/**
 * The inventory: every tab of the group as a thumbnail, down the desk's
 * leading side. A click brings a tab out as a window (or its window to the
 * top); a drag pulls it out and drops it wherever it is let go. A window
 * dropped back on the column — or flung at it — is put away into it.
 *
 * Below the thumbnails: the arrangements, and the variants this
 * experiment is for, each a click to cycle.
 */
export const DeskRail = memo(function DeskRail({
  group,
  tabs,
  view,
  engine,
}: {
  group: TabGroupInfo;
  tabs: readonly BrowserTabInfo[];
  view: DeskView;
  engine: DeskEngine;
}) {
  const onDesk = new Set(view.windows.map((window) => window.tabId));
  const focused = view.windows.find((window) => window.focused)?.tabId ?? null;
  const tabIds = tabs.map((tab) => tab.id);
  return (
    <aside
      aria-label={`${group.title}: the group's tabs`}
      data-testid="desk-rail"
      data-armed={view.railArmed ? "" : undefined}
      data-group-color={group.color}
      className="desk-rail tab-group-tone"
      style={{ width: RAIL_W }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 pr-1 pl-2.5">
        <span className="size-2 shrink-0 rounded-full bg-(--tg-solid)" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-(--tg-text)">{group.title}</span>
        <span className="text-[10.5px] text-gray-700 tabular-nums">{tabs.length}</span>
        <button
          type="button"
          title="Leave the desk"
          aria-label="Leave the desk"
          data-testid="desk-leave"
          onClick={() => useDeskStore.getState().leave()}
          className="grid size-6 cursor-pointer place-items-center rounded-md text-gray-800 outline-none transition-colors duration-150 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="desk-rail-list" role="list">
        {tabs.map((tab) => (
          <Thumb
            key={tab.id}
            tab={tab}
            src={view.thumbs.get(tab.id) ?? null}
            onDesk={onDesk.has(tab.id)}
            focused={focused === tab.id}
            engine={engine}
          />
        ))}
      </div>
      <footer className="flex shrink-0 flex-col gap-1.5 border-t border-alpha-200 px-2 pt-2 pb-2">
        <div className="flex items-center gap-1">
          <RailAction label="Tile the windows" onClick={() => engine.arrange("tile", tabIds)}>
            <LayoutGrid aria-hidden="true" />
          </RailAction>
          <RailAction label="Cascade the windows" onClick={() => engine.arrange("cascade", tabIds)}>
            <Layers2 aria-hidden="true" />
          </RailAction>
          <RailAction label="Every tab out, tiled" onClick={() => engine.gather(tabIds)}>
            <Sparkles aria-hidden="true" />
          </RailAction>
        </div>
        <Variants />
      </footer>
      <div className="desk-rail-drop" aria-hidden="true">
        Put away
      </div>
    </aside>
  );
});

function Thumb({
  tab,
  src,
  onDesk,
  focused,
  engine,
}: {
  tab: BrowserTabInfo;
  src: string | null;
  onDesk: boolean;
  focused: boolean;
  engine: DeskEngine;
}) {
  const attach = useCallback((el: HTMLDivElement | null) => engine.attachThumb(tab.id, el), [engine, tab.id]);
  const host = displayHost(tab.url);
  const title = tab.title || host || "Untitled";
  return (
    <div
      role="listitem"
      tabIndex={0}
      title={onDesk ? `${title} — on the desk` : `${title} — click or drag out`}
      data-testid="desk-thumb"
      data-tab-id={tab.id}
      data-on-desk={onDesk ? "" : undefined}
      data-focused={focused ? "" : undefined}
      className="desk-thumb"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        engine.pressThumb(tab.id, event);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        engine.add(tab.id, { focus: true });
      }}
    >
      <div ref={attach} className="desk-thumb-shot">
        {src !== null ? (
          <img src={src} alt="" draggable={false} />
        ) : (
          <Favicon src={tab.faviconUrl} seed={host || title} className="size-7 rounded-lg text-[13px]" />
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 px-0.5">
        <Favicon src={tab.faviconUrl} seed={host || title} className="size-3" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-900">{title}</span>
      </div>
    </div>
  );
}

function RailAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-7 flex-1 cursor-pointer place-items-center rounded-md bg-alpha-100 text-gray-900 outline-none transition-[background-color,transform] duration-150 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

/**
 * The variants under test, one row per axis. A click moves to the next
 * choice (shift-click to the previous); the hint says what it changes.
 */
function Variants() {
  const variants = useDeskStore((state) => state.variants);
  const [open, setOpen] = useState(true);
  return (
    <div data-testid="desk-variants" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-1 text-[10.5px] font-semibold tracking-wide text-gray-700 uppercase outline-none hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex-1 text-left">Feel</span>
        <ChevronDown aria-hidden="true" className={cn("size-3 transition-transform duration-150", !open && "-rotate-90")} />
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5">
          {DESK_AXES.map((axis) => (
            <VariantRow key={axis.key} axisKey={axis.key} label={axis.label} variants={variants} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function VariantRow({ axisKey, label, variants }: { axisKey: keyof DeskVariants; label: string; variants: DeskVariants }) {
  const axis = DESK_AXES.find((candidate) => candidate.key === axisKey)!;
  const options = axis.options as ReadonlyArray<{ id: string; label: string; hint: string }>;
  const index = options.findIndex((option) => option.id === variants[axisKey]);
  const option = options[index] ?? options[0]!;
  return (
    <button
      type="button"
      data-testid={`desk-variant-${axisKey}`}
      data-value={option.id}
      title={`${option.hint} — click for the next`}
      onClick={(event) => {
        const store = useDeskStore.getState();
        if (!event.shiftKey) {
          store.cycleVariant(axisKey);
          return;
        }
        const previous = options[(index - 1 + options.length) % options.length]!;
        store.setVariant(axisKey, previous.id as DeskVariants[typeof axisKey]);
      }}
      className="group/variant flex h-6 cursor-pointer items-center gap-1 rounded-md px-1 text-[11px] outline-none transition-colors duration-150 hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="w-14 shrink-0 text-left text-gray-700">{label}</span>
      <span key={option.id} className="desk-variant-value min-w-0 flex-1 truncate text-left font-medium text-gray-1000">
        {option.label}
      </span>
      <ChevronsUpDown aria-hidden="true" className="size-3 shrink-0 text-gray-600 group-hover/variant:text-gray-900" />
    </button>
  );
}
