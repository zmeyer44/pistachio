import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { useAppStore } from "../store";

/**
 * A right-click menu for the chrome — the sidebar's rows, tiles, and folders.
 * Owned by whichever component opens it (`useContextMenu`), rendered as a
 * fixed card clamped inside the window. Plain buttons: a click runs the item and closes;
 * Escape, a press anywhere outside, or the window losing focus closes it.
 * ↑/↓ walk the items and ↵ runs one, so a keyboard-opened menu (Shift+F10
 * on a row) is usable without a pointer.
 */

export type MenuEntry =
  | {
      label: string;
      icon?: React.ReactNode;
      onSelect(): void;
      disabled?: boolean;
      /** A red item: closes, deletes. */
      danger?: boolean;
      /** A checkmark before the label. */
      checked?: boolean;
    }
  | { separator: true }
  /** A muted caption, e.g. "Managed by your organization". */
  | { note: string }
  /**
   * One row of round colour swatches — a tab group's colour. `color` is a
   * `data-group-color` name (shell.css), so the swatch is the colour the row
   * will take, in either scheme. A `clear` swatch is no colour at all (a
   * folder's default): an empty ring rather than a hue.
   */
  | { swatches: ReadonlyArray<{ id: string; label: string; clear?: boolean }>; selected: string; onPick(id: string): void }
  /**
   * An icon chooser — a folder's emoji: `reset` (the default icon) and a grid
   * of `choices`, then a field for any other. `parse` is the owner's rule for
   * what the field may hold; it picks the moment the text is one.
   */
  | {
      emoji: {
        choices: readonly string[];
        selected: string | null;
        reset: { label: string; icon: React.ReactNode };
        parse(text: string): string | null;
        onPick(emoji: string | null): void;
      };
    };

interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

const MENU_W = 220;
const EDGE = 6;

export function useContextMenu(): {
  /** Open at a pointer event's position (or at an element's corner for a keyboard open). */
  open(at: { clientX: number; clientY: number }, items: MenuEntry[]): void;
  close(): void;
  isOpen: boolean;
  menu: React.ReactNode;
} {
  const [state, setState] = useState<MenuState | null>(null);
  const overlayReady = useAppStore((store) => store.overlayReady);
  const setContextMenuOpen = useAppStore((store) => store.setContextMenuOpen);
  const open = useCallback((at: { clientX: number; clientY: number }, items: MenuEntry[]) => {
    if (items.length === 0) return;
    setState({ x: at.clientX, y: at.clientY, items });
    setContextMenuOpen(true);
  }, [setContextMenuOpen]);
  const close = useCallback(() => {
    setState(null);
    setContextMenuOpen(false);
  }, [setContextMenuOpen]);
  useEffect(() => () => setContextMenuOpen(false), [setContextMenuOpen]);
  return {
    open,
    close,
    isOpen: state !== null,
    menu: state === null
      ? null
      : createPortal(<ContextMenu state={state} ready={overlayReady} onClose={close} />, document.body),
  };
}

function ContextMenu({ state, ready, onClose }: { state: MenuState; ready: boolean; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const [focused, setFocused] = useState(-1);
  // The window listeners below read the focused item through this ref, so a
  // focus change (every pointer move over an item) does not re-register them.
  const focusedRef = useRef(focused);
  useLayoutEffect(() => {
    focusedRef.current = focused;
  }, [focused]);
  const selectable = useMemo(
    () => state.items.map((item, i) => ("label" in item && item.disabled !== true ? i : -1)).filter((i) => i >= 0),
    [state.items],
  );

  // Clamp inside the window once the card has a size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(EDGE, Math.min(state.x, window.innerWidth - width - EDGE)),
      y: Math.max(EDGE, Math.min(state.y, window.innerHeight - height - EDGE)),
    });
  }, [state]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node) !== true) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setFocused((current) => {
          const at = selectable.indexOf(current);
          const step = event.key === "ArrowDown" ? 1 : -1;
          const next = at < 0 ? (step > 0 ? 0 : selectable.length - 1) : (at + step + selectable.length) % selectable.length;
          return selectable[next] ?? -1;
        });
        return;
      }
      // ↵ in the emoji field is the field's own.
      if (event.target instanceof HTMLInputElement) return;
      const focusedNow = focusedRef.current;
      if (event.key === "Enter" && focusedNow >= 0) {
        event.preventDefault();
        const item = state.items[focusedNow];
        if (item !== undefined && "label" in item) {
          onClose();
          item.onSelect();
        }
      }
    };
    // Capture: the menu must see the press before any row under it does.
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, selectable, state.items]);

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="context-menu"
      className={cn(
        "no-drag fixed z-50 flex flex-col rounded-md bg-background-100 p-1 shadow-menu",
        ready ? "animate-overlay-in" : "pointer-events-none opacity-0",
      )}
      style={{ left: pos.x, top: pos.y, width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((item, i) => {
        if ("separator" in item) return <span key={i} role="separator" className="my-1 h-px bg-alpha-400" />;
        if ("note" in item) {
          return (
            <span key={i} className="px-2 py-1 text-[11px] text-gray-700">
              {item.note}
            </span>
          );
        }
        if ("swatches" in item) {
          return (
            <div key={i} role="group" aria-label="Colour" className="flex items-center justify-between px-2 py-1.5">
              {item.swatches.map((swatch) => (
                <button
                  key={swatch.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={swatch.id === item.selected}
                  aria-label={swatch.label}
                  title={swatch.label}
                  data-group-color={swatch.clear === true ? undefined : swatch.id}
                  data-testid={`group-color-${swatch.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                    item.onPick(swatch.id);
                  }}
                  className={cn(
                    "size-4 cursor-pointer rounded-full outline-none transition-transform duration-150 hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    swatch.clear === true ? "border border-gray-700" : "tab-group-tone bg-(--tg-solid)",
                    swatch.id === item.selected &&
                      (swatch.clear === true
                        ? "ring-2 ring-gray-700 ring-offset-2 ring-offset-background-100"
                        : "ring-2 ring-(--tg-solid) ring-offset-2 ring-offset-background-100"),
                  )}
                />
              ))}
            </div>
          );
        }
        if ("emoji" in item) {
          const { choices, selected, reset, parse, onPick } = item.emoji;
          const pick = (emoji: string | null): void => {
            onClose();
            onPick(emoji);
          };
          const cell =
            "grid size-6 cursor-pointer place-items-center rounded-sm text-[14px] leading-none outline-none transition-transform duration-150 hover:bg-alpha-200 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.92] motion-reduce:transition-none motion-reduce:active:scale-100 aria-checked:bg-alpha-300";
          return (
            <div key={i} role="group" aria-label="Icon" className="flex flex-col gap-1 px-1 py-1">
              <div className="grid grid-cols-8 justify-items-center gap-y-0.5">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected === null}
                  aria-label={reset.label}
                  title={reset.label}
                  data-testid="menu-emoji-reset"
                  onClick={(e) => {
                    e.stopPropagation();
                    pick(null);
                  }}
                  className={cn(cell, "text-gray-900 [&_svg]:size-3.5")}
                >
                  {reset.icon}
                </button>
                {choices.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitemradio"
                    aria-checked={emoji === selected}
                    aria-label={emoji}
                    data-testid="menu-emoji-choice"
                    onClick={(e) => {
                      e.stopPropagation();
                      pick(emoji);
                    }}
                    className={cell}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <input
                aria-label="Custom emoji"
                data-testid="menu-emoji-input"
                placeholder="Or type any emoji"
                // A chosen emoji that is not in the grid shows here, so it is still visibly the choice.
                defaultValue={selected !== null && !choices.includes(selected) ? selected : ""}
                onFocus={(e) => {
                  setFocused(-1);
                  e.target.select();
                }}
                onChange={(e) => {
                  const emoji = parse(e.target.value);
                  if (emoji !== null) pick(emoji);
                }}
                spellCheck={false}
                autoComplete="off"
                className="mx-1 h-6 min-w-0 rounded-sm bg-alpha-200 px-1.5 text-[12px] text-gray-1000 outline-none placeholder:text-gray-700 focus-visible:ring-1 focus-visible:ring-alpha-400"
              />
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-focused={focused === i ? "" : undefined}
            onMouseMove={() => setFocused(i)}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
              item.onSelect();
            }}
            className={cn(
              "flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[12.5px] outline-none disabled:cursor-default disabled:text-gray-600 [&_svg]:size-3.5 [&_svg]:shrink-0",
              item.danger ? "text-red-900 hover:bg-red-100 data-[focused]:bg-red-100" : "text-gray-1000 hover:bg-alpha-200 data-[focused]:bg-alpha-200",
            )}
          >
            <span
              className={cn(
                "grid size-3.5 shrink-0 place-items-center",
                item.danger || item.disabled ? "text-current" : "text-gray-900",
              )}
            >
              {item.checked === true ? <Check aria-hidden="true" /> : item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
