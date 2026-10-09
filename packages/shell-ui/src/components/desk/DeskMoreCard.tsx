import { Fragment, type ReactNode } from "react";
import { ChevronsUpDown, Layers2, LayoutGrid, Sparkles } from "lucide-react";
import { shortcutLabel, type ShortcutPlatform } from "@pistachio/shell-contracts/shortcuts";
import { cn } from "../../lib/cn";
import { GLIDE_DECELERATION } from "../../lib/desk/motion";
import { DESK_AXES, useDeskStore, type DeskAxisKey, type DeskVariants } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import { Kbd } from "../ui/kbd";
import { Slider } from "../ui/slider";

const PLATFORM: ShortcutPlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";

/**
 * The desk's card, beside its button in the sidebar (DeskMoreButton): the
 * arrangements (each with its keyboard shortcut, from Settings) and the
 * variants this experiment is for (Feel). Drawn over the desk, so it is a
 * cover, seen once no live page is under it. (Until 2026-10-09 it also had
 * the way out, Leave the desk: the desk is the browser now, docs/spaces.md.)
 */
export function DeskMoreCard({
  ref,
  shown,
  left,
  top,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
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
  onTile: () => void;
  onCascade: () => void;
  /** The smart layout (docs/desk-layout.md): the windows laid out the way the layout model judges they are used. */
  onArrange: () => void;
}) {
  const tile = useAppStore((state) => shortcutLabel(state.settings.shortcuts.tileDesk, PLATFORM));
  const cascade = useAppStore((state) => shortcutLabel(state.settings.shortcuts.cascadeDesk, PLATFORM));
  const arrange = useAppStore((state) => shortcutLabel(state.settings.shortcuts.arrangeDesk, PLATFORM));
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
        <div className="px-1.5 pt-0.5 pb-1 text-[10.5px] font-semibold tracking-wide text-gray-700 uppercase">Feel</div>
        {DESK_AXES.map((axis) => (
          <Fragment key={axis.key}>
            <VariantRow axisKey={axis.key} label={axis.label} />
            {/* Glide's own setting, under the throw it belongs to. */}
            {axis.key === "physics" ? <DecelerationRow /> : null}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** One of the More card's actions: its icon, its words, and its shortcut if it has one. */
function MoreItem({ label, hint, testId, onClick, children }: { label: string; hint?: string | null; testId: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-gray-1000 outline-none transition-colors duration-150 hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-gray-900"
    >
      {children}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint === undefined || hint === null ? null : <Kbd small>{hint}</Kbd>}
    </button>
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
