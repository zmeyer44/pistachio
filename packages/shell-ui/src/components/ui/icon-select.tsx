import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

export interface IconSelectItem<T extends string> {
  value: T;
  label: string;
  icon: React.ReactNode;
}

/**
 * Select, for choices a person knows by their mark — a search engine, an
 * assistant. The native <select> (ui/select.tsx) cannot draw an image in its
 * list, so this is the collapsed-listbox pattern on a button: the closed face
 * matches Select's, and the list shows each item's icon beside its name.
 *
 * Keyboard, as a native select has it: ↵/Space/↓/↑ on the button open the
 * list on the current value; ↓/↑/Home/End move; ↵/Space choose; Escape and
 * Tab close without choosing. Focus never leaves the button — the active
 * option is named through `aria-activedescendant` — so closing cannot strand
 * it. A press outside, or the window losing focus, closes too.
 *
 * The list is portalled to the body and placed against the button's rect:
 * the settings cards clip their corners (`overflow: hidden`), and a list
 * hung inside one is cut off at the card's edge. It opens downward, or
 * upward when the window has no room below; a scroll or resize under it
 * closes it rather than leaving it adrift from its button.
 */

/** The list's gap from its button, and the height of one option — for the up/down decision before it is measured. */
const LIST_GAP = 6;
const OPTION_HEIGHT = 32;
const LIST_PADDING = 8;
export function IconSelect<T extends string>({
  value,
  items,
  onValueChange,
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  value: T;
  items: ReadonlyArray<IconSelectItem<T>>;
  onValueChange: (value: T) => void;
  className?: string;
  "aria-label": string;
  "data-testid"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<React.CSSProperties | null>(null);
  const listId = useId();
  const current = items.find((item) => item.value === value) ?? items[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return setOpen(false);
      const inside = rootRef.current?.contains(event.target) === true || listRef.current?.contains(event.target) === true;
      if (!inside) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    // Capture: the scroll that matters is the settings page's own, not the window's.
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!open || root === null) return setPlace(null);
    const rect = root.getBoundingClientRect();
    const height = items.length * OPTION_HEIGHT + LIST_PADDING;
    const below = window.innerHeight - rect.bottom - LIST_GAP;
    const up = below < height && rect.top - LIST_GAP > below;
    setPlace({
      position: "fixed",
      right: window.innerWidth - rect.right,
      minWidth: rect.width,
      ...(up ? { bottom: window.innerHeight - rect.top + LIST_GAP } : { top: rect.bottom + LIST_GAP }),
    });
  }, [open, items.length]);

  if (current === undefined) return null;

  const show = () => {
    setActive(Math.max(0, items.findIndex((item) => item.value === value)));
    setOpen(true);
  };

  const choose = (index: number) => {
    const item = items[index];
    setOpen(false);
    if (item !== undefined && item.value !== value) onValueChange(item.value);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        show();
      }
      return;
    }
    if (key === "Escape") {
      // The settings page closes on Escape too; this one only closes the list.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (key === "Tab") {
      setOpen(false);
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      choose(active);
    } else if (key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, items.length - 1));
    } else if (key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (key === "End") {
      event.preventDefault();
      setActive(items.length - 1);
    }
  };

  return (
    <span ref={rootRef} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${String(active)}` : undefined}
        data-testid={testId}
        data-value={current.value}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm bg-background-100 pr-8 pl-2.5 text-left text-label-13 text-gray-1000 shadow-border outline-none transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--color-gray-500)] focus-visible:shadow-[0_0_0_1px_var(--color-gray-1000),0_0_0_4px_var(--color-alpha-200)]",
          open && "shadow-[0_0_0_1px_var(--color-gray-1000),0_0_0_4px_var(--color-alpha-200)]",
        )}
      >
        {current.icon}
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
      </button>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-gray-700"
      />
      {open && place !== null
        ? createPortal(
            <span
              ref={listRef}
              style={place}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              data-testid={testId === undefined ? undefined : `${testId}-list`}
              className="animate-overlay-in z-80 flex flex-col rounded-lg bg-background-100 p-1 text-gray-1000 shadow-menu"
            >
              {items.map((item, index) => (
                <span
                  key={item.value}
                  id={`${listId}-${String(index)}`}
                  role="option"
                  aria-selected={item.value === value}
                  data-value={item.value}
                  onPointerMove={() => setActive(index)}
                  // The button keeps focus: a press here must not blur it before the click lands.
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                  className={cn(
                    "flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[12.5px] whitespace-nowrap",
                    index === active && "bg-alpha-200",
                  )}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {item.value === value ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-gray-900" /> : null}
                </span>
              ))}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
