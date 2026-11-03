import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import { LEDGE_RAIL_MAX } from "@pistachio/shell-contracts/extensions";
import { activateExtension, openExtensionsPage } from "../../lib/extensions/actions";
import { ledgeCapacity, ledgeDropIndex } from "../../lib/extensions/ledge";
import { leaveLedge, ledgeItems } from "../../lib/extensions/ledge-focus";
import { extensionsRequest, useExtensionsState, useLedgeExtensions } from "../../lib/extensions/use-extensions";
import { useContextMenu } from "../ContextMenu";
import { LedgeIcon } from "./LedgeIcon";
import { extensionMenuEntries } from "./menu";

/** A press this far along the Ledge is an icon carried, not a click. */
const CARRY_START_PX = 4;

/** An icon carried along the Ledge: which, from where, how far, and where it would land. */
interface Carry {
  id: string;
  from: number;
  dx: number;
  to: number;
}

/**
 * The Ledge (docs/extensions.md X9, §2): where extensions are seen. At the
 * foot of the sidebar's card (`variant="card"`), a 36px strip sharing its
 * row with the footer's pills — the pinned extensions' icons on the leading
 * side, 28px targets 4px apart, as many as the room leaves the pills, the
 * rest flowing into ⋯, which ends the strip and opens
 * `pistachio://extensions/`. With none pinned it is one dashed slot and the
 * word *Extensions* (the page too), the twin of the empty Stack's sheet. In
 * the rail alone (`variant="rail"`) it is a short column at the rail's foot,
 * above New space: up to LEDGE_RAIL_MAX icons, 24px, and ⋯ — never a tile.
 *
 * A click runs the icon (lib/extensions/actions.ts); a right-click is its
 * menu; carried along the strip it moves (`reorder`, its index among the
 * Ledge's icons). ⌘⇧E puts the keyboard here (lib/extensions/ledge-focus.ts):
 * a roving tabindex, ←/→ walk, ↵ runs, 1–9 run the nth, ⎋ gives it back.
 *
 * Drawn from main's snapshot alone; on a host with no extensions, nothing.
 */
export function Ledge({ variant }: { variant: "card" | "rail" }) {
  const extensions = useLedgeExtensions();
  const unsupported = useExtensionsState((state) => state.unsupported);
  const openPanel = useExtensionsState((state) => state.snapshot.openPanel);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(0);
  const [carry, setCarry] = useState<Carry | null>(null);
  /** The click a carry's release makes is the carry's, not a run. */
  const carried = useRef(false);
  const stopCarry = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || variant !== "card") return;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [variant]);
  useEffect(() => () => stopCarry.current?.(), []);

  const room = variant === "rail" ? Math.min(LEDGE_RAIL_MAX, extensions.length) : ledgeCapacity(width, extensions.length);
  const shown = extensions.slice(0, room);
  const itemCount = extensions.length === 0 && variant === "card" ? 1 : shown.length + 1;
  const focusAt = Math.min(current, itemCount - 1);

  if (unsupported !== null) return null;

  const press = (index: number, event: React.PointerEvent<HTMLButtonElement>): void => {
    stopCarry.current?.();
    if (event.button !== 0 || variant !== "card") return;
    const id = shown[index]?.id;
    const strip = ref.current;
    if (id === undefined || strip === null) return;
    const startX = event.clientX;
    const centers = [...strip.querySelectorAll<HTMLElement>("[data-testid='ledge-icon']")].map((el) => {
      const box = el.getBoundingClientRect();
      return box.left + box.width / 2;
    });
    let moving = false;
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      if (!moving && Math.abs(dx) < CARRY_START_PX) return;
      moving = true;
      setCarry({ id, from: index, dx, to: ledgeDropIndex(centers, index, ev.clientX) });
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (stopCarry.current === stop) stopCarry.current = null;
    };
    const onUp = (ev: PointerEvent): void => {
      stop();
      setCarry(null);
      if (!moving) return;
      carried.current = true;
      window.setTimeout(() => (carried.current = false), 0);
      const to = ledgeDropIndex(centers, index, ev.clientX);
      if (to !== index) void extensionsRequest({ type: "reorder", id, index: to });
    };
    const onCancel = (): void => {
      stop();
      setCarry(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    stopCarry.current = stop;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const strip = ref.current;
    if (strip === null || event.metaKey || event.ctrlKey || event.altKey) return;
    const items = ledgeItems(strip);
    const at = items.findIndex((item) => item === document.activeElement);
    const step = variant === "rail" ? { next: "ArrowDown", back: "ArrowUp" } : { next: "ArrowRight", back: "ArrowLeft" };
    if (event.key === step.next || event.key === step.back) {
      event.preventDefault();
      const next = (Math.max(0, at) + (event.key === step.next ? 1 : -1) + items.length) % items.length;
      setCurrent(next);
      items[next]?.focus({ preventScroll: true });
      return;
    }
    if (/^[1-9]$/u.test(event.key)) {
      const extension = shown[Number(event.key) - 1];
      if (extension === undefined) return;
      event.preventDefault();
      activateExtension(extension, items[Number(event.key) - 1] ?? null);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      leaveLedge();
    }
  };

  const empty = extensions.length === 0;
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Extensions"
      aria-orientation={variant === "rail" ? "vertical" : "horizontal"}
      data-ledge=""
      data-testid={variant === "rail" ? "ledge-rail" : "ledge"}
      data-variant={variant}
      data-empty={empty ? "" : undefined}
      data-carrying={carry !== null ? "" : undefined}
      className="ledge no-drag"
      onKeyDown={onKeyDown}
    >
      {empty && variant === "card" ? (
        <button
          type="button"
          data-ledge-item=""
          data-testid="ledge-empty"
          tabIndex={0}
          className="ledge-empty"
          onMouseDown={(event) => event.preventDefault()}
          onClick={openExtensionsPage}
        >
          <span className="ledge-empty-slot" aria-hidden="true" />
          Extensions
        </button>
      ) : (
        <>
          {shown.map((extension, index) => (
            <LedgeIcon
              key={extension.id}
              extension={extension}
              open={openPanel === extension.id}
              tabIndex={index === focusAt ? 0 : -1}
              carried={carry?.id === extension.id}
              dropBefore={carry !== null && carry.to !== carry.from && dropSlot(carry) === index}
              offset={carry?.id === extension.id ? carry.dx : 0}
              onPointerDown={(event) => press(index, event)}
              onFocus={() => setCurrent(index)}
              onClick={(el) => {
                if (carried.current) return;
                activateExtension(extension, el);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                menu.open(event, extensionMenuEntries(extension));
              }}
            />
          ))}
          <button
            type="button"
            data-ledge-item=""
            data-testid="ledge-more"
            data-drop-before={carry !== null && carry.to !== carry.from && dropSlot(carry) === shown.length ? "" : undefined}
            aria-label={extensions.length > shown.length ? `All extensions (${String(extensions.length - shown.length)} more)` : "All extensions"}
            title="Extensions"
            tabIndex={focusAt === shown.length ? 0 : -1}
            className="ledge-icon ledge-more"
            onMouseDown={(event) => event.preventDefault()}
            onFocus={() => setCurrent(shown.length)}
            onClick={openExtensionsPage}
          >
            <Ellipsis aria-hidden="true" />
          </button>
        </>
      )}
      {menu.menu}
    </div>
  );
}

/** The icon the carried one would land before (its index among all the drawn items; the ⋯ past the last). */
function dropSlot(carry: Carry): number {
  // `to` counts the others; among the items as drawn (the carried one still in its place) that is one more past it.
  return carry.to >= carry.from ? carry.to + 1 : carry.to;
}
