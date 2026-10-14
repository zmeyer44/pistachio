import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { Sparkles } from "lucide-react";
import type { GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { shortcutLabel, type ShortcutPlatform } from "@pistachio/shell-contracts/shortcuts";
import { fileOf } from "../../lib/desk/documents";
import { type Rect } from "../../lib/desk/geometry";
import { ARRANGE_WORDS, LAYOUT_WORDS, layoutsFor, layoutsOn, slotRects, type DeskLayoutKind } from "../../lib/desk/layouts";
import { arrangeDesk, useCurrentSpace, useDeskEngine, useDeskView } from "../../lib/desk/open";
import { fileItemOf } from "../../lib/desk/windows";
import { displayHost } from "../../lib/url";
import { useAppStore } from "../../store";
import { Favicon } from "../Favicon";
import { Kbd } from "../ui/kbd";
import type { DeskLayoutPreview } from "./desk-engine";
import { FileGlyph } from "./files/FileGlyph";

const PLATFORM: ShortcutPlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";

/** A segment of the track: a named layout, or the layout model's own (Arrange for me). */
type Choice = DeskLayoutKind | "smart";

/**
 * A space's layouts, in the double sidebar's space view (docs/double-sidebar.md §1 "Layouts"): one segmented track of
 * the layouts its windows allow (lib/desk/layouts.ts, layoutsFor), each a line drawing of itself, the one the desk is
 * in holding the raised thumb (none, the windows set down by hand), and apart at its end Arrange for me (the layout
 * model, ⌘⌥L). Under the track a caption names the layout the desk is in — or, the pointer or the keyboard on a
 * segment, that one, with its shortcut — and resting on a layout draws where each window would go as ghosts on the
 * desk (the engine's previewLayout; DeskSurface draws them, LayoutGhosts below). A click lays the windows out
 * (layOut): a beat apart, ⌃Z putting them back for five seconds after.
 *
 * Only while its space is the one on the desk, and only with windows out: the engine is the current space's.
 */
export function LayoutControl({ groupId }: { groupId: string }): React.ReactNode {
  const engine = useDeskEngine();
  const view = useDeskView(engine);
  const current = useCurrentSpace();
  const tileKey = useAppStore((state) => shortcutLabel(state.settings.shortcuts.tileDesk, PLATFORM));
  const cascadeKey = useAppStore((state) => shortcutLabel(state.settings.shortcuts.cascadeDesk, PLATFORM));
  const arrangeKey = useAppStore((state) => shortcutLabel(state.settings.shortcuts.arrangeDesk, PLATFORM));
  const [hovered, setHovered] = useState<Choice | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  /** The segments the thumb was last placed among: rebuilt (another number of windows), it jumps rather than slides. */
  const placedFor = useRef("");

  const shown = engine !== null && view !== null && current === groupId && view.layoutCount > 0;
  const count = shown ? view.layoutCount : 0;
  // (Main and side only while its column holds the rest, Columns and Stacked only while each window keeps its least
  // size: the room on the desk as it is now, layoutsOn.)
  const bounds = engine === null || count < 2 ? null : engine.layoutView().bounds;
  const deskW = bounds?.w ?? 0;
  const deskH = bounds?.h ?? 0;
  const kinds = useMemo(() => (deskW > 0 && deskH > 0 ? layoutsOn(count, { x: 0, y: 0, w: deskW, h: deskH }) : layoutsFor(count)), [count, deskW, deskH]);
  const kindsKey = `${String(count)}:${kinds.join(",")}`;
  const layout = shown ? view.layout : null;
  const shortcutOf = (choice: Choice): string | null => (choice === "tile" ? tileKey : choice === "cascade" ? cascadeKey : choice === "smart" ? arrangeKey : null);

  // A layout looked at is drawn on the desk — not the one it is in, nor Arrange for me (the model's choice is not known
  // until it is asked) — and taken away as the pointer or the keyboard leaves the track.
  const previewed = shown && hovered !== null && hovered !== "smart" && hovered !== layout ? hovered : null;
  useEffect(() => {
    engine?.previewLayout(previewed);
  }, [engine, previewed]);
  useEffect(() => () => engine?.previewLayout(null), [engine]);
  // The segment hovered is gone (fewer windows), or the whole control (its space no longer on the desk): the hover goes
  // with it, so nothing is previewed when it is back.
  useEffect(() => {
    if (hovered === null) return;
    if (!shown || (hovered !== "smart" && !kinds.includes(hovered))) setHovered(null);
  }, [hovered, kinds, shown]);

  // The thumb under the layout the desk is in, sliding from the last; placed at once among new segments — and when it
  // comes back after being away (no layout, or the control itself gone: a new thumb), so it fades in where it belongs
  // rather than sliding in from wherever it was (or from the track's start). (Until 2026-10-13 it did.)
  useLayoutEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (track === null || thumb === null) {
      placedFor.current = "";
      return;
    }
    const on = layout === null ? null : track.querySelector<HTMLElement>(`[data-testid="layout-option"][data-kind="${layout}"]`);
    if (on === null) {
      delete thumb.dataset["on"];
      placedFor.current = "";
      return;
    }
    const instant = placedFor.current !== kindsKey;
    placedFor.current = kindsKey;
    if (instant) track.dataset["instant"] = "";
    thumb.style.width = `${String(on.offsetWidth)}px`;
    thumb.style.transform = `translateX(${String(on.offsetLeft)}px)`;
    if (instant) {
      void thumb.offsetWidth;
      delete track.dataset["instant"];
    }
    thumb.dataset["on"] = "";
  }, [layout, kindsKey, shown]);

  if (!shown) return null;

  const leave = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    if (next === null || trackRef.current?.contains(next) !== true) setHovered(null);
  };
  // The keyboard on a segment looks at it as the pointer resting there does — the keyboard's focus only: a segment
  // clicked keeps the focus, and is focused again when the app comes back to the front, which must not draw ghosts on
  // the desk out of nowhere. (Until 2026-10-13 any focus did.)
  const look = (event: FocusEvent<HTMLElement>, choice: Choice): void => {
    if (keyboardFocus(event.currentTarget)) setHovered(choice);
  };
  const caption = captionOf(hovered, layout, count);
  const hint = hovered === null ? null : shortcutOf(hovered);
  return (
    <div data-testid="layout-control" className="layout-control">
      <div
        ref={trackRef}
        role="group"
        aria-label="Layouts"
        className="layout-track"
        onPointerLeave={() => setHovered(null)}
      >
        <span ref={thumbRef} className="layout-thumb" aria-hidden="true" />
        {kinds.map((kind) => {
          const key = shortcutOf(kind);
          return (
            <button
              key={kind}
              type="button"
              data-testid="layout-option"
              data-kind={kind}
              aria-pressed={kind === layout}
              aria-label={key === null ? LAYOUT_WORDS[kind].label : `${LAYOUT_WORDS[kind].label} (${key})`}
              className="layout-option"
              onPointerEnter={() => setHovered(kind)}
              onFocus={(event) => look(event, kind)}
              onBlur={leave}
              onClick={() => {
                engine.layOut(kind);
              }}
            >
              <LayoutGlyph kind={kind} count={count} />
            </button>
          );
        })}
        {count >= 2 ? (
          <>
            <span className="layout-sep" aria-hidden="true" />
            <button
              type="button"
              data-testid="layout-arrange"
              data-kind="smart"
              aria-label={arrangeKey === null ? ARRANGE_WORDS.label : `${ARRANGE_WORDS.label} (${arrangeKey})`}
              className="layout-option"
              onPointerEnter={() => setHovered("smart")}
              onFocus={(event) => look(event, "smart")}
              onBlur={leave}
              onClick={() => void arrangeDesk("smart")}
            >
              <Sparkles aria-hidden="true" className="size-[15px]" strokeWidth={1.7} />
            </button>
          </>
        ) : null}
      </div>
      <p data-testid="layout-caption" className="layout-caption" data-hover={hovered !== null ? "" : undefined}>
        <b>{caption.label}</b>
        {caption.text === null ? null : `: ${caption.text}`}
        {hint === null ? null : (
          <Kbd small className="layout-caption-key">
            {hint}
          </Kbd>
        )}
      </p>
    </div>
  );
}

/** The element has the keyboard's focus (`:focus-visible`), not a click's or the window's coming back. */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** What the caption says: the layout looked at, else the one the desk is in, else that the windows were set down by hand. */
function captionOf(hovered: Choice | null, layout: DeskLayoutKind | null, count: number): { label: string; text: string | null } {
  if (hovered === "smart") return { label: ARRANGE_WORDS.label, text: ARRANGE_WORDS.caption };
  if (hovered !== null) return { label: LAYOUT_WORDS[hovered].label, text: LAYOUT_WORDS[hovered].caption(count) };
  if (count === 1) return { label: "Fill the desk", text: "one window" };
  if (layout === null) return { label: "Arranged by hand", text: "pick a layout to tidy the windows" };
  return { label: LAYOUT_WORDS[layout].label, text: LAYOUT_WORDS[layout].caption(count) };
}

/** The glyph's own box, inside a 1px margin for the stroke. */
const GLYPH = { w: 24, h: 16 };

/**
 * A layout as a small line drawing, from the desk's own places for it (slotRects) with a hairline gutter: the main
 * place (Tile's first, Main and side's) shaded. A cascade is drawn as at most three steps, the rest as at most six.
 */
function LayoutGlyph({ kind, count }: { kind: DeskLayoutKind; count: number }) {
  const inner = { x: 0, y: 0, w: GLYPH.w - 2, h: GLYPH.h - 2 };
  const shown = Math.max(1, kind === "cascade" ? Math.min(count, 3) : Math.min(count, 6));
  const rects = kind === "cascade" ? cascadeGlyph(shown, inner) : (slotRects(kind, shown, inner, 1.6) ?? []);
  return (
    <svg className="layout-glyph" width={GLYPH.w} height={GLYPH.h} viewBox={`0 0 ${String(GLYPH.w)} ${String(GLYPH.h)}`} fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" aria-hidden="true">
      {rects.map((rect, index) => {
        const main = index === 0 && rects.length > 1 && (kind === "focus" || kind === "tile");
        return (
          <rect
            key={index}
            x={(rect.x + 1).toFixed(1)}
            y={(rect.y + 1).toFixed(1)}
            width={Math.max(1, rect.w).toFixed(1)}
            height={Math.max(1, rect.h).toFixed(1)}
            rx={1.6}
            fill={main ? "currentColor" : "var(--layout-glyph-fill)"}
            fillOpacity={main ? 0.22 : 1}
          />
        );
      })}
    </svg>
  );
}

/** A cascade's steps at a glyph's size (cascadeRects keeps a window's least size, which a glyph has no room for). */
function cascadeGlyph(count: number, box: Rect): Rect[] {
  const step = count < 2 ? 0 : Math.min(10, (box.h * 0.5) / (count - 1), (box.w * 0.5) / (count - 1));
  const span = step * (count - 1);
  const w = Math.max(box.w * 0.4, Math.min(box.w - span, Math.round(box.w * 0.62)));
  const h = Math.max(box.h * 0.4, Math.min(box.h - span, Math.round(box.h * 0.74)));
  const x = box.x + Math.max(0, (box.w - w - span) / 2);
  const y = box.y + Math.max(0, (box.h - h - span) / 2);
  return Array.from({ length: count }, (_, index) => ({ x: x + index * step, y: y + index * step, w, h }));
}

/**
 * Where each window would go for a layout looked at (DeskView.preview), drawn over the desk's windows: a dashed outline
 * in the space's colour, a faint wash of it, and the window's mark in the middle — its tab's icon, or a document's
 * file glyph. DeskSurface draws it only once the `layout-preview` cover is clear (no live page under it: nothing the
 * shell draws can be seen over one). Each ghost glides from one layout's place to the next as the pointer moves along
 * the track.
 */
export function LayoutGhosts({
  preview,
  tabsById,
  contexts,
}: {
  preview: DeskLayoutPreview;
  tabsById: ReadonlyMap<string, BrowserTabInfo>;
  contexts: readonly GroupContextView[];
}) {
  return (
    <div data-testid="desk-layout-ghosts" data-kind={preview.kind} className="desk-layout-ghosts" aria-hidden="true">
      {preview.ghosts.map((ghost) => {
        const tab = tabsById.get(ghost.id) ?? null;
        const itemId = tab === null ? fileItemOf(ghost.id) : null;
        const file = itemId === null ? null : fileOf(contexts, itemId);
        return (
          <div
            key={ghost.id}
            data-testid="desk-layout-ghost"
            data-id={ghost.id}
            className="desk-layout-ghost"
            style={{ transform: `translate(${String(ghost.rect.x)}px, ${String(ghost.rect.y)}px)`, width: ghost.rect.w, height: ghost.rect.h }}
          >
            <span className="desk-layout-ghost-mark">
              {file !== null ? (
                <FileGlyph mediaType={file.item.mediaType} className="size-5" />
              ) : (
                <Favicon src={tab?.faviconUrl ?? null} seed={displayHost(tab?.url ?? "") || (tab?.title ?? "")} className="size-5" />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
