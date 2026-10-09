import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { nativeApi } from "../api";
import { useDeskCover } from "../lib/desk/chrome";
import { Favicon } from "./Favicon";

/** The pointer resting on the folder this long opens its sheet: one passing over it on its way down the rail does not. */
const OPEN_DELAY_MS = 120;
/** The sheet stays this long after the pointer leaves it and the folder, to cross between them (the desk's cards' grace). */
const LINGER_MS = 300;
/** The sheet stands this far above the folder's top, and keeps this far inside the window. */
const SHEET_RISE = 8;
const SHEET_MARGIN = 8;
/** The desk's cover for the sheet (DeskEngine.setCover): the live pages under it give way to their stills. */
const COVER = "favorites";

export interface RailFavorite {
  id: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  /** The dragged item drawn at the slot a drop would give it: not a favorite yet. */
  ghost: boolean;
}

/**
 * The favorites on the desk's rail (docs/desk.md, "The rail"): one folder
 * tile — the first four favorites' icons and how many there are — in place
 * of a row per favorite. The pointer resting on it, a click, or the keyboard
 * slides a sheet out of the rail's edge over the desk: a piece of the whole
 * sidebar, holding the favorites grid itself (FavoritesGrid's tiles, with
 * their menus, live dots and the page in view's tile). A click pins it until
 * a press elsewhere or Escape; otherwise it goes a moment after the pointer
 * leaves both. It is a cover over the desk: the live pages under it give way
 * to their stills, and it shows once they have.
 *
 * Under the folder stand the favorites whose pages are open, a row each
 * (`open`, drawn by FavoritesGrid), so the ones in use are a click away as
 * a tab's row is.
 *
 * Dropping onto the favorites still works on the rail: a row dragged onto
 * the folder opens the sheet, and the grid in it takes the drop (the drag's
 * `gridRef` is the folder while the sheet is shut, the sheet's grid while it
 * is out).
 */
export function RailFavorites({
  favorites,
  open: openRows,
  gridRef,
  gridClassName,
  dragging,
  dropping,
  children,
}: {
  favorites: readonly RailFavorite[];
  /** The rows of the favorites whose pages are open, under the folder. */
  open: readonly ReactNode[];
  /** The favorites' drop target for the sidebar's drag (chrome/shelf-drag.tsx). */
  gridRef: RefObject<HTMLDivElement | null>;
  gridClassName: string;
  /** A drag the favorites could take is in flight: the sheet stays while it lasts. */
  dragging: boolean;
  /** That drag is aimed at the favorites. */
  dropping: boolean;
  /** The grid's tiles. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const folderRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  const openTimer = useRef(0);
  const lingerTimer = useRef(0);
  const own = favorites.filter((favorite) => !favorite.ghost);

  const close = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(lingerTimer.current);
    pinned.current = false;
    setOpen(false);
  }, []);
  const show = useCallback((pin: boolean) => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(lingerTimer.current);
    if (pin) pinned.current = true;
    setOpen(true);
  }, []);
  /** The pointer left the folder or the sheet: unless it comes back to one, or a click pinned it, or a drag is on, it goes. */
  const linger = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(lingerTimer.current);
    lingerTimer.current = window.setTimeout(() => {
      if (pinned.current || draggingRef.current) return;
      if (folderRef.current?.matches(":hover") === true || sheetRef.current?.matches(":hover") === true) return;
      setOpen(false);
    }, LINGER_MS);
  }, []);
  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(lingerTimer.current);
  }, []);

  // A row dragged onto the folder opens the sheet for the drop; once the drag is over, it goes as the pointer would have it.
  useEffect(() => {
    if (dropping) show(false);
  }, [dropping, show]);
  const wasDragging = useRef(dragging);
  useEffect(() => {
    if (wasDragging.current && !dragging && open) linger();
    wasDragging.current = dragging;
  }, [dragging, open, linger]);

  // Out of the rail level with the folder, kept inside the window.
  useLayoutEffect(() => {
    const folder = folderRef.current;
    const sheet = sheetRef.current;
    if (!open || folder === null || sheet === null) return;
    const top = folder.getBoundingClientRect().top - SHEET_RISE;
    setShift(Math.max(0, top + sheet.offsetHeight - (window.innerHeight - SHEET_MARGIN)));
  }, [open, own.length]);

  // A cover over the desk while it is out: it shows once the live pages under it have given way. A window taken in
  // hand puts it away, as it does the desk's cards. (Its shift moves it without a change of size: the hook measures
  // it again as it renders.)
  const shown = useDeskCover(COVER, sheetRef, open, { onGesture: close });

  // A press anywhere else (a live page's too, which main relays), or Escape.
  useEffect(() => {
    if (!open) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "press" || input === "escape") close();
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (target !== null && (sheetRef.current?.contains(target) === true || folderRef.current?.contains(target) === true)) return;
      close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const inside = sheetRef.current?.contains(document.activeElement) === true;
      close();
      if (inside) folderRef.current?.focus();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const tiles = (): HTMLElement[] => [...(sheetRef.current?.querySelectorAll<HTMLElement>("[role='listitem']") ?? [])];
  const focusFirst = (): void => {
    requestAnimationFrame(() => {
      const all = tiles();
      (all.find((tile) => tile.getAttribute("aria-pressed") === "true") ?? all[0])?.focus();
    });
  };
  // In the sheet the arrow keys move through the favorites, three to a row.
  const onSheetKey = (event: ReactKeyboardEvent): void => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 };
    const step = steps[event.key];
    const all = tiles();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (step === undefined || at < 0) return;
    event.preventDefault();
    all[Math.max(0, Math.min(all.length - 1, at + step))]?.focus();
  };

  return (
    <div className="rail-favorites relative mx-2 mb-2 shrink-0">
      <div ref={open ? undefined : gridRef} className="rail-favorites-target">
        <button
          ref={folderRef}
          type="button"
          aria-label={`Favorites, ${String(own.length)}`}
          aria-expanded={open}
          aria-controls="rail-favorites-sheet"
          data-testid="rail-favorites"
          data-dropping={dropping && !open ? "" : undefined}
          className="rail-favorites-folder no-drag"
          // A press leaves the keyboard where it was (a window's page).
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={() => {
            window.clearTimeout(lingerTimer.current);
            if (open) return;
            window.clearTimeout(openTimer.current);
            openTimer.current = window.setTimeout(() => show(false), OPEN_DELAY_MS);
          }}
          onPointerLeave={linger}
          onClick={() => (open && pinned.current ? close() : show(true))}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            show(true);
            focusFirst();
          }}
        >
          <span className="rail-favorites-mosaic" aria-hidden="true">
            {own.slice(0, 4).map((favorite) => (
              <Favicon key={favorite.id} src={favorite.faviconUrl} seed={favorite.url} className="rail-favorites-mark" />
            ))}
          </span>
          <span className="rail-favorites-count" aria-hidden="true">
            {own.length}
          </span>
        </button>
      </div>
      {openRows.length === 0 ? null : (
        // Scrolled within (a favorite's desk's rows run long): the rows' own box, positioned, moves with the scroll,
        // so a row in hand is placed by where it is now (the sidebar's drag reads offsetParent + offsetTop).
        <div data-testid="rail-favorites-open" className="rail-favorites-open">
          <div role="list" aria-label="Open favorites" className="rail-favorites-open-rows">
            {openRows}
          </div>
        </div>
      )}
      <div
        ref={sheetRef}
        id="rail-favorites-sheet"
        role="group"
        aria-label="Favorites"
        data-testid="rail-favorites-sheet"
        data-open={open ? "" : undefined}
        data-shown={open && shown ? "" : undefined}
        inert={!open}
        className="rail-favorites-sheet no-drag"
        style={{ top: -SHEET_RISE - shift }}
        onPointerEnter={() => window.clearTimeout(lingerTimer.current)}
        onPointerLeave={linger}
        onKeyDown={onSheetKey}
        // A favorite opened: the sheet has done its work.
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("[role='listitem']") !== null) close();
        }}
      >
        <div className="rail-favorites-head">
          <span>Favorites</span>
          <span>{own.length}</span>
        </div>
        <div ref={open ? gridRef : undefined} role="list" aria-label="Favorites" data-testid="favorites-grid" className={gridClassName}>
          {children}
        </div>
      </div>
    </div>
  );
}
