import { Fragment, type ReactNode } from "react";
import { Check, ChevronRight, ChevronsUpDown, Layers2, LayoutGrid, Sparkles } from "lucide-react";
import { create } from "zustand";
import { shortcutLabel, type ShortcutPlatform } from "@pistachio/shell-contracts/shortcuts";
import { cn } from "../../lib/cn";
import { GLIDE_DECELERATION } from "../../lib/desk/motion";
import { DESK_AXES, useDeskStore, type DeskAxisKey, type DeskVariants } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import { SwatchRow, type MenuEntry } from "../ContextMenu";
import { columnViewOf, HOME_VIEW, type RailSpace } from "../space-rail/rail-model";
import { useSpaceMenu } from "../space-rail/space-menu";
import { Kbd } from "../ui/kbd";
import { Slider } from "../ui/slider";

const PLATFORM: ShortcutPlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";

/** Whether the More card's Feel is let out: folded away until the person opens it, as they left it since. */
const useFeelOpen = create<{ open: boolean; toggle(): void }>((set) => ({ open: false, toggle: () => set((state) => ({ open: !state.open })) }));

/**
 * The space in use as the rail has it (rail-model's RailSpace), or null in Home:
 * a drawn space, or a page's space (a favorite's or pin's page with company).
 */
function useCurrentRailSpace(): RailSpace | null {
  const view = useAppStore((state) => columnViewOf(state.snapshot?.currentGroupId ?? null, state.snapshot));
  const drawn = useAppStore((state) => (view === HOME_VIEW ? null : (state.snapshot?.tabGroups.find((group) => group.id === view) ?? null)));
  const page = useAppStore((state) => (view === HOME_VIEW || drawn !== null ? null : (state.snapshot?.anchorGroups?.find((group) => group.id === view) ?? null)));
  if (drawn !== null) return { group: drawn, page: false };
  return page === null ? null : { group: page, page: true };
}

/**
 * The desk's card, beside its button in the sidebar (DeskMoreButton): the
 * space in use's own controls, as its tile's menu has them (useSpaceMenu:
 * its name, its colour, a new tab, sharing it live, releasing or closing it
 * — none in Home), the arrangements (each with its keyboard shortcut, from
 * Settings), and the variants this experiment is for (Feel), folded away
 * under their heading. Drawn over the desk, so it is a cover, seen once no
 * live page is under it. (Until 2026-10-09 it also had the way out, Leave
 * the desk: the desk is the browser now, docs/spaces.md. Until 2026-10-21
 * Feel was always out, and the space's controls were its tile's alone.)
 */
export function DeskMoreCard({
  ref,
  shown,
  left,
  top,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onClose,
  onTile,
  onCascade,
  onArrange,
}: {
  ref: React.Ref<HTMLDivElement>;
  shown: boolean;
  /** Its corner in the stage. */
  left: number;
  top: number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  /** Put the card away (a space's action was chosen on it). */
  onClose: () => void;
  onTile: () => void;
  onCascade: () => void;
  /** The smart layout (docs/desk-layout.md): the windows laid out the way the layout model judges they are used. */
  onArrange: () => void;
}) {
  const tile = useAppStore((state) => shortcutLabel(state.settings.shortcuts.tileDesk, PLATFORM));
  const cascade = useAppStore((state) => shortcutLabel(state.settings.shortcuts.cascadeDesk, PLATFORM));
  const arrange = useAppStore((state) => shortcutLabel(state.settings.shortcuts.arrangeDesk, PLATFORM));
  const space = useCurrentRailSpace();
  const spaceMenu = useSpaceMenu();
  const entries = space === null ? [] : spaceMenu(space);
  const feelOpen = useFeelOpen((state) => state.open);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="More"
      data-testid="desk-more-card"
      data-shown={shown ? "" : undefined}
      className="desk-dock-menu desk-dock-more"
      style={{ left, top }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
    >
      {entries.length > 0 ? (
        <>
          <div role="group" aria-label="Space" data-testid="desk-more-space" className="flex flex-col gap-px">
            <div className="px-1.5 pt-0.5 pb-1 text-[10.5px] font-semibold tracking-wide text-gray-700 uppercase">Space</div>
            {entries.map((entry, index) => (
              <SpaceEntry key={index} entry={entry} onClose={onClose} />
            ))}
          </div>
          <span className="desk-more-divider" aria-hidden="true" />
        </>
      ) : null}
      <MoreItem label="Tile the windows" hint={tile} testId="desk-tile" onClick={onTile}>
        <LayoutGrid aria-hidden="true" />
      </MoreItem>
      <MoreItem label="Cascade the windows" hint={cascade} testId="desk-cascade" onClick={onCascade}>
        <Layers2 aria-hidden="true" />
      </MoreItem>
      <MoreItem label="Arrange for me" hint={arrange} testId="desk-arrange" onClick={onArrange}>
        <Sparkles aria-hidden="true" />
      </MoreItem>
      <span className="desk-more-divider" aria-hidden="true" />
      <div role="group" aria-label="Feel" data-testid="desk-variants" className="flex flex-col gap-px">
        <button
          type="button"
          aria-expanded={feelOpen}
          aria-controls="desk-feel-rows"
          data-testid="desk-feel-toggle"
          onMouseDown={(event) => event.preventDefault()}
          onClick={useFeelOpen.getState().toggle}
          className="group/feel flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[10.5px] font-semibold tracking-wide text-gray-700 uppercase outline-none transition-colors duration-150 hover:bg-alpha-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex-1 text-left">Feel</span>
          <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none", feelOpen && "rotate-90")} />
        </button>
        {feelOpen ? (
          <div id="desk-feel-rows" className="flex flex-col gap-px">
            {DESK_AXES.map((axis) => (
              <Fragment key={axis.key}>
                {axis.key === "zoom" ? <PageZoomRow label={axis.label} /> : <VariantRow axisKey={axis.key} label={axis.label} />}
                {/* Glide's own setting, under the throw it belongs to. */}
                {axis.key === "physics" ? <DecelerationRow /> : null}
              </Fragment>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One of the More card's actions: its icon, its words, and its shortcut if it has one. */
function MoreItem({
  label,
  hint,
  testId,
  danger = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  hint?: string | null;
  testId?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[12px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:text-gray-600 [&_svg]:size-3.5 [&_svg]:shrink-0",
        danger ? "text-red-900 hover:bg-red-100 [&_svg]:text-current" : "text-gray-1000 hover:bg-alpha-100 disabled:hover:bg-transparent [&_svg]:text-gray-900 disabled:[&_svg]:text-current",
      )}
    >
      {children}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint === undefined || hint === null ? null : <Kbd small>{hint}</Kbd>}
    </button>
  );
}

/**
 * One of the space's menu entries (useSpaceMenu), laid out on the card: an
 * action puts the card away and runs (Rename opens the name in the card's
 * head); a colour is picked with the card left up, its ring moving to it.
 */
function SpaceEntry({ entry, onClose }: { entry: MenuEntry; onClose: () => void }) {
  if ("separator" in entry) return <span className="desk-more-divider" aria-hidden="true" />;
  if ("swatches" in entry) return <SwatchRow entry={entry} />;
  if (!("label" in entry)) return null;
  return (
    <MoreItem
      label={entry.label}
      {...(entry.testId === undefined ? {} : { testId: entry.testId })}
      danger={entry.danger === true}
      disabled={entry.disabled === true}
      onClick={() => {
        onClose();
        entry.onSelect();
      }}
    >
      {entry.checked === true ? <Check aria-hidden="true" /> : (entry.icon ?? <span aria-hidden="true" />)}
    </MoreItem>
  );
}

/**
 * Glide's deceleration: how quickly a thrown window slows, as the share of
 * its speed it loses every 100 ms. Only a Glide throw coasts, so it waits,
 * dimmed, under any other.
 */
function DecelerationRow() {
  const deceleration = useDeskStore((state) => state.variants.deceleration);
  const glide = useDeskStore((state) => state.variants.physics === "glide");
  return (
    <div
      data-testid="desk-variant-deceleration"
      data-value={deceleration}
      title={glide ? "How quickly a thrown window slows down: the share of its speed it loses every 100 ms" : "Only a Glide throw coasts: choose Glide above"}
    >
      <Slider
        label="Deceleration"
        value={deceleration}
        min={GLIDE_DECELERATION.min}
        max={GLIDE_DECELERATION.max}
        disabled={!glide}
        onChange={(value) => useDeskStore.getState().setVariant("deceleration", value)}
        className={cn("grid-cols-[76px_minmax(60px,1fr)_30px] gap-2 px-1.5 py-1", !glide && "opacity-60")}
        labelClassName="text-[12px] text-gray-700"
      />
    </div>
  );
}

/**
 * Page zoom: how far a page zooms out as its window takes less of the desk,
 * a slider over its strengths, weakest first, from Off (every page at 100%)
 * to Strongest. The windows on the desk follow it as it moves.
 */
function PageZoomRow({ label }: { label: string }) {
  const value = useDeskStore((state) => state.variants.zoom);
  const options = DESK_AXES.find((axis) => axis.key === "zoom")!.options;
  const index = Math.max(0, options.findIndex((option) => option.id === value));
  const option = options[index]!;
  return (
    <div data-testid="desk-variant-zoom" data-value={option.id} title={option.hint}>
      <Slider
        label={label}
        value={index}
        min={0}
        max={options.length - 1}
        readout={option.label}
        onChange={(step) => useDeskStore.getState().setVariant("zoom", options[step]!.id)}
        className="grid-cols-[76px_minmax(60px,1fr)_56px] gap-2 px-1.5 py-1"
        labelClassName="text-[12px] text-gray-700"
      />
    </div>
  );
}

/**
 * One variant axis. A click moves to the next choice (shift-click to the
 * previous); the hint says what it changes.
 */
function VariantRow({ axisKey, label }: { axisKey: DeskAxisKey; label: string }) {
  const value = useDeskStore((state) => state.variants[axisKey]);
  const axis = DESK_AXES.find((candidate) => candidate.key === axisKey)!;
  const options = axis.options as ReadonlyArray<{
    id: string;
    label: string;
    hint: string;
  }>;
  const index = options.findIndex((option) => option.id === value);
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
      className="group/variant flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] outline-none transition-colors duration-150 hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="w-[76px] shrink-0 text-left text-gray-700">{label}</span>
      <span key={option.id} className="desk-variant-value min-w-0 flex-1 truncate text-left font-medium text-gray-1000">
        {option.label}
      </span>
      <ChevronsUpDown aria-hidden="true" className="size-3 shrink-0 text-gray-600 group-hover/variant:text-gray-900" />
    </button>
  );
}
