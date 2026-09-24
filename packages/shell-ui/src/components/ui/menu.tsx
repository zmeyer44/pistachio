import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { cn } from "../../lib/cn";
import { Kbd } from "./kbd";

/**
 * A menu on a chrome button — the sidebar footer's menu and Space avatar.
 * Two ways in: HOVER shows it while the pointer holds the button or the
 * panel (a hover card), and a CLICK pins it (a popover) until a press
 * outside, Escape, the window losing focus, or picking an item. Keyboard:
 * ↓/↑ on the button opens it on the first/last item, ↓/↑ walk the items,
 * Home/End jump, ↵ or Space run the focused one, Escape returns focus to
 * the button, Tab leaves and closes.
 *
 * The panel is positioned by the caller's root (`relative`) and always
 * opens upward: these menus live at the bottom of a column. The panel and
 * the gap between it and the button are inside the root, so a hover-opened
 * menu stays up while the pointer crosses to it.
 */

type OpenMode = "hover" | "pinned" | null;
type ItemEdge = "first" | "last";

/**
 * How long a hover-opened menu outlives a pointer leave before it believes
 * it. Matches the sidebar's own leave check (layouts/SidebarLayout.tsx): a
 * leave the window drag region reports is often not one.
 */
const LEAVE_GRACE_MS = 120;

export interface MenuButton {
  open: boolean;
  pinned: boolean;
  panelId: string;
  rootRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  close(): void;
  rootProps: { onPointerEnter(): void; onPointerLeave(): void };
  triggerProps: {
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    onClick(event: ReactMouseEvent<HTMLButtonElement>): void;
    onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
  };
}

function itemsOf(panel: HTMLElement | null): HTMLElement[] {
  if (panel === null) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'));
}

function focusEdge(panel: HTMLElement | null, edge: ItemEdge): void {
  const items = itemsOf(panel);
  (edge === "first" ? items[0] : items.at(-1))?.focus();
}

export function useMenuButton({ hover = true, dismissed = false }: { hover?: boolean; dismissed?: boolean } = {}): MenuButton {
  const [mode, setMode] = useState<OpenMode>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<ItemEdge | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const panelId = useId();
  const cancelLeave = useCallback(() => {
    if (leaveTimer.current === null) return;
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);
  const close = useCallback(() => {
    cancelLeave();
    setMode(null);
  }, [cancelLeave]);
  useEffect(() => cancelLeave, [cancelLeave]);

  // The caller's reason to drop the menu — the compact column hid, say.
  useEffect(() => {
    if (dismissed) setMode(null);
  }, [dismissed]);

  // A keyboard open lands on an item once the panel exists.
  useEffect(() => {
    if (mode === null || pendingFocus.current === null) return;
    focusEdge(panelRef.current, pendingFocus.current);
    pendingFocus.current = null;
  }, [mode]);

  // Capture-phase so the page's own Escape and press handlers stay out of it.
  useEffect(() => {
    if (mode === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target) !== true) setMode(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMode(null);
      triggerRef.current?.focus();
    };
    const onBlur = () => setMode(null);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [mode]);

  const openOn = (edge: ItemEdge) => {
    if (mode === null) {
      pendingFocus.current = edge;
      setMode("pinned");
      return;
    }
    setMode("pinned");
    focusEdge(panelRef.current, edge);
  };

  return {
    open: mode !== null,
    pinned: mode === "pinned",
    panelId,
    rootRef,
    triggerRef,
    panelRef,
    close,
    rootProps: {
      onPointerEnter: () => {
        cancelLeave();
        if (hover && mode === null) setMode("hover");
      },
      // A leave is a prompt, not yet a fact: the pointer crossing the window
      // drag region around the column's controls reads as a momentary exit
      // even while it is still over the menu, so a hover-opened menu waits
      // out the grace and closes only if the pointer has not come back.
      onPointerLeave: () => {
        if (mode !== "hover") return;
        cancelLeave();
        leaveTimer.current = window.setTimeout(() => {
          leaveTimer.current = null;
          setMode((current) => (current === "hover" ? null : current));
        }, LEAVE_GRACE_MS);
      },
    },
    triggerProps: {
      "aria-haspopup": "menu",
      "aria-expanded": mode !== null,
      "aria-controls": mode === null ? undefined : panelId,
      onClick: (event) => {
        if (mode === "pinned") {
          setMode(null);
          return;
        }
        // A keyboard "click" (Enter/Space) opens onto the first item; a
        // pointer click leaves focus where it is.
        if (event.detail === 0) openOn("first");
        else setMode("pinned");
      },
      onKeyDown: (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        openOn(event.key === "ArrowDown" ? "first" : "last");
      },
    },
  };
}

const MenuContext = createContext<{ close(): void } | null>(null);

function useMenu(): { close(): void } {
  const menu = useContext(MenuContext);
  if (menu === null) throw new Error("MenuItem needs a <MenuPanel> above it");
  return menu;
}

/** The panel, mounted while the menu is open, anchored above the button at its start or end. */
export function MenuPanel({
  menu,
  label,
  align,
  testId,
  children,
}: {
  menu: MenuButton;
  label: string;
  align: "start" | "end";
  testId?: string;
  children: React.ReactNode;
}) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      menu.close();
      return;
    }
    const items = itemsOf(event.currentTarget);
    if (items.length === 0) return;
    const at = items.findIndex((item) => item === document.activeElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
    else if (event.key === "ArrowUp") next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };
  // `no-drag` on the wrapper, not just the panel: it hangs outside the footer
  // row's own no-drag rect, over the column's window drag region, and the
  // app-region property is not inherited. Over a drag region the page sees
  // the pointer leave for a moment (see layouts/SidebarLayout.tsx), which
  // would close a hover-opened menu on the way from the button to the
  // panel. The wrapper's padding is that bridge, so it opts out too.
  return (
    <div className={cn("no-drag absolute bottom-full z-80 pb-1.5", align === "start" ? "left-0" : "right-0")}>
      <div
        ref={menu.panelRef}
        id={menu.panelId}
        role="menu"
        aria-label={label}
        data-testid={testId}
        data-pinned={menu.pinned ? "" : undefined}
        onKeyDown={onKeyDown}
        className="animate-overlay-in flex w-48 flex-col rounded-lg bg-background-100 p-1 text-gray-1000 shadow-menu"
      >
        <MenuContext.Provider value={menu}>{children}</MenuContext.Provider>
      </div>
    </div>
  );
}

/** One command. Selecting it closes the menu first, so what it opens is not under a menu. */
export function MenuItem({
  icon,
  label,
  note,
  hint,
  active = false,
  disabled = false,
  tone = "default",
  testId,
  href = null,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  /** A second, muted line. */
  note?: string;
  /** The shortcut, as a key cap. */
  hint?: string | null;
  /** The command's on-state (a panel it opened is open). */
  active?: boolean;
  disabled?: boolean;
  /** The icon's colour when it carries meaning: needs attention, or on. */
  tone?: "default" | "amber" | "green";
  testId?: string;
  /**
   * An address on another site. A row with one is a real anchor rather than a
   * button that calls `window.open`: the destination is outside the app, and
   * a reader should be able to see and copy where a row is about to send
   * them. It replaces `onSelect`, which is then never called.
   */
  href?: string | null;
  onSelect(): void;
}) {
  const { close } = useMenu();
  const Tag = href === null ? "button" : "a";
  return (
    <Tag
      {...(href === null
        ? { type: "button" as const }
        : { href, target: "_blank", rel: "noreferrer noopener" })}
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled ? true : undefined}
      data-testid={testId}
      data-active={active ? "" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        close();
        if (href === null) onSelect();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 text-left outline-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        note === undefined ? "h-7" : "py-1.5",
        disabled ? "cursor-default text-gray-600" : "cursor-pointer hover:bg-alpha-200 focus:bg-alpha-200",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-3.5 shrink-0 place-items-center",
          disabled ? "text-gray-600" : tone === "amber" ? "text-amber-900" : tone === "green" || active ? "text-green-900" : "text-gray-900",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[12.5px]", note !== undefined && "leading-4")}>{label}</span>
        {note === undefined ? null : <span className="block truncate text-[10.5px] leading-3.5 text-gray-700">{note}</span>}
      </span>
      {hint === undefined || hint === null ? null : <Kbd small>{hint}</Kbd>}
    </Tag>
  );
}

export function MenuSeparator() {
  return <span role="separator" className="my-1 h-px bg-alpha-400" />;
}

/** A muted caption over a group of items. */
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <span className="px-2 pt-1 pb-0.5 text-[10.5px] font-medium text-gray-700">{children}</span>;
}
