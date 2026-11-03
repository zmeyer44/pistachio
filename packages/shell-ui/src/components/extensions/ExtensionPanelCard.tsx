import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { Ellipsis, X } from "lucide-react";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { nativeApi } from "../../api";
import { useDeskChrome } from "../../lib/desk/chrome";
import { boundsOf } from "../../lib/extensions/actions";
import { isOwnSource } from "../../lib/extensions/ledge";
import { extensionsRequest, useExtension, useExtensionsState } from "../../lib/extensions/use-extensions";
import { CONTEXT_MENU_W, useContextMenu, type MenuEntry } from "../ContextMenu";
import type { DeskEngine, DeskView } from "../desk/desk-engine";
import { ExtensionMark } from "./LedgeIcon";
import { extensionMenuEntries } from "./menu";

/** The card stands this far from the sidebar's edge, over the desk, as the desk's own cards do (DeskSideCard). */
const CARD_GAP = 10;
/** A panel's width when its manifest names none (docs/extensions.md §4: 240–480, 360 to start). */
const PANEL_W = 360;
const PANEL_W_MIN = 240;
const PANEL_W_MAX = 480;

/** The width a panel is drawn at: the one its manifest declares, within the range, else the default. */
export function panelWidthOf(extension: { panelWidth: number | null }): number {
  const declared = extension.panelWidth;
  if (declared === null || !Number.isFinite(declared)) return PANEL_W;
  return Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, Math.round(declared)));
}
/** Its height: the snapshot names none, and main sizes the view to its content within the slot. */
const PANEL_H = 480;
/** Its cover's key among the desk's (DeskEngine.setCover). */
const PANEL_COVER = "extension-panel";

/**
 * An extension's panel (docs/extensions.md §4): when `openPanel` names one, a
 * card beside the sidebar, over the desk, as the More card is — a cover, so
 * the live pages under it give way to their stills and it shows once they
 * have; a press anywhere else (a live page's too), ⎋, or a window taken in
 * hand closes it (`closePanel`). Its head is the shell's — the extension's
 * mark and name, never the frame's own — with ⋯ (its menu) and ×; its body
 * is an empty slot whose box in the window the shell reports
 * (`setExtensionPanelBounds`, the Glance recipe: measured as it moves or
 * resizes, null once it goes), and main places the extension's sandboxed view
 * there. The shell draws nothing inside.
 */
export function ExtensionPanelCard({ engine, view, stageRef }: { engine: DeskEngine; view: DeskView; stageRef: RefObject<HTMLDivElement | null> }) {
  const openPanel = useExtensionsState((state) => state.snapshot.openPanel);
  const anchor = useExtensionsState((state) => state.panelAnchor);
  const extension = useExtension(openPanel);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const open = extension !== null;
  const shown = open && view.clearCovers.has(PANEL_COVER);
  const busy = view.gesture !== null;

  // Opening it puts the desk's own card away: two cards beside the sidebar would stand on each other.
  useEffect(() => {
    if (open) useDeskChrome.getState().closeCard();
  }, [open]);
  // A window taken in hand puts it away, as the desk's cards go.
  useEffect(() => {
    if (open && busy) void extensionsRequest({ type: "closePanel" }, { quiet: true });
  }, [open, busy]);

  // Its cover: from the sidebar's edge to its trailing edge, so the pointer crossing the gap is the shell's.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!open || el === null) {
      engine.setCover(PANEL_COVER, null);
      return;
    }
    const measure = (): void => engine.setCover(PANEL_COVER, { x: 0, y: el.offsetTop, w: el.offsetLeft + el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [engine, open, anchor]);
  useEffect(() => () => engine.setCover(PANEL_COVER, null), [engine]);

  // The slot, reported in the window's coordinates while the card is shown; null as it goes.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const native = nativeApi();
    if (native === null) return;
    if (!shown || body === null) {
      native.setExtensionPanelBounds(null);
      return;
    }
    let last = "";
    const report = (): void => {
      const bounds: ContentBounds = boundsOf(body);
      const key = `${String(bounds.x)}:${String(bounds.y)}:${String(bounds.width)}:${String(bounds.height)}`;
      if (key === last) return;
      last = key;
      native.setExtensionPanelBounds(bounds);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(body);
    const stage = stageRef.current;
    if (stage !== null) observer.observe(stage);
    // (Its transform settles after it is shown, and the window can move the stage without resizing the slot.)
    const settle = window.setTimeout(report, 200);
    window.addEventListener("resize", report);
    window.addEventListener("scroll", report, true);
    return () => {
      observer.disconnect();
      window.clearTimeout(settle);
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
      native.setExtensionPanelBounds(null);
    };
  }, [shown, stageRef, openPanel]);

  // A press anywhere else (a live page's too), or ⎋. The Ledge's icons toggle it themselves; a menu it opened is its own.
  useEffect(() => {
    if (!open) return;
    const close = (): void => void extensionsRequest({ type: "closePanel" }, { quiet: true });
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "press" || input === "escape") close();
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && (cardRef.current?.contains(target) === true || target.closest("[data-ledge-id]") !== null || target.closest("[role='menu']") !== null)) return;
      close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const stage = stageRef.current?.getBoundingClientRect() ?? null;
  if (extension === null || stage === null) return <>{menu.menu}</>;
  const height = Math.max(160, Math.min(PANEL_H, stage.height - 16));
  // Level with the icon it was opened from, its foot with the icon's (the Ledge is at the card's foot), as far down as it fits.
  const top = anchor === null ? stage.height - height - 8 : Math.max(8, Math.min(anchor.y + anchor.height - stage.top - height, stage.height - height - 8));
  const left = Math.max(CARD_GAP, (anchor === null ? stage.left : Math.max(stage.left, anchor.x + anchor.width)) - stage.left + CARD_GAP);
  // Its ⋯: *Options*, and for one of the person's own *Reload*, *Show folder*, *Logs* (the Ledge's menu, less what the
  // Ledge is for: pinning, turning it off, removing it).
  const kept = new Set(["extension-menu-options", "extension-menu-reload", "extension-menu-folder", "extension-menu-logs"]);
  const more: MenuEntry[] = extensionMenuEntries(extension).filter((entry) => "label" in entry && kept.has(entry.testId ?? ""));
  if (isOwnSource(extension.source)) more.splice(1, 0, { separator: true });
  return (
    <>
      <div
        ref={cardRef}
        role="dialog"
        aria-label={extension.name}
        data-testid="extension-panel-card"
        data-extension-id={extension.id}
        data-shown={shown ? "" : undefined}
        className="extension-panel-card no-drag"
        style={{ left, top, width: panelWidthOf(extension), height }}
      >
        <div className="extension-panel-head">
          <ExtensionMark extension={extension} />
          <span className="extension-panel-name">{extension.name}</span>
          <button
            type="button"
            className="extension-panel-button"
            aria-label={`${extension.name} options`}
            title="More"
            data-testid="extension-panel-more"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              menu.open({ clientX: box.right - CONTEXT_MENU_W, clientY: box.bottom + 4 }, more);
            }}
          >
            <Ellipsis aria-hidden="true" />
          </button>
          <button
            type="button"
            className="extension-panel-button"
            aria-label="Close"
            title="Close (Esc)"
            data-testid="extension-panel-close"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void extensionsRequest({ type: "closePanel" })}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div ref={bodyRef} className="extension-panel-body" data-testid="extension-panel-slot" />
      </div>
      {menu.menu}
    </>
  );
}
