/**
 * Drag-to-reorder and FLIP for a row of tab slots, generalized over an axis
 * so the horizontal strip and the vertical list share one implementation.
 * The geometry — which offset is "along the row", which way "lift" goes,
 * where the split zones are — is chrome/drag-geometry.ts (pure, tested);
 * this is the gesture over it.
 *
 * Split-by-drag needs the page's viewport box (`contentBounds`). Crossing its
 * near edge along the lift axis "lifts" the slot out of the row (the row stops
 * reordering and the slot may roam the window); SPLIT_ARM_PX further in, and
 * no further than the box's far edge, over the box along the row axis, arms
 * the left/right drop zones. With `contentBounds === null` (the compact
 * flyout, whose page is in another renderer) there is no lift and no split —
 * only reorder.
 *
 * Two clocks run during a gesture. The POINTER moves every frame: both
 * sources (the window's own pointermove and the drag layer's relayed samples)
 * are coalesced onto one animation frame, and that frame writes the dragged
 * slot's transform and the layer's ghost directly — no React. The ROW changes
 * only when the drop index, the split zone, or the lifted flag does: that is
 * the `TabDrag` the row renders `view` from, and the only thing that reaches
 * `setDrag`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TabDragClamp } from "@pistachio/shell-contracts/chrome";
import type { BrowserTabInfo, ContentBounds } from "@pistachio/shell-contracts/ipc";
import { useAppStore } from "../store";
import { AXES, SURFACE_INSET, splitZoneAt, type AxisGeometry, type DragAxis, type PointerLike, type SplitZone } from "./drag-geometry";
import type { RowItem } from "./tabs";
import { nativeApi } from "../api";

export type { DragAxis, PointerLike, SplitZone } from "./drag-geometry";

/** The row's tail (the + button): never a slot, but it bounds the row. */
export const NEW_TAB_FLIP_ID = "__new-tab";

const SETTLE_EASING = "cubic-bezier(0.22, 0.9, 0.26, 1)";
/** Pointer travel that turns a press into a drag rather than a click. */
const DRAG_START_PX = 5;
/** How long a committed drop's order may wait for main to publish it before the row's own order takes over. */
const SETTLE_TIMEOUT_MS = 1_000;

/** Every slot's layout start under `root`, by flip id. */
function readSlotStarts(root: HTMLElement, g: AxisGeometry): Map<string, number> {
  const starts = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
    const id = el.dataset["flipId"];
    if (id !== undefined) starts.set(id, g.start(el));
  }
  return starts;
}

/**
 * FLIP-animate the row: whenever slots reorder or appear, glide each element
 * from its previous layout position to its new one. Positions are read from
 * the layout offset — never from getBoundingClientRect, which includes any
 * in-flight transform. `skipId` is the slot under the pointer during a drag:
 * its position is recorded but never animated, since the pointer positions it.
 *
 * Every child carrying `data-flip-id` takes part, the new-tab tail included:
 * that is why the tail must never change width on hover — a recorded position
 * would go stale.
 *
 * The row's layout changes when `layoutKey` does — the slots in view order,
 * with whatever sizes them — so that is when positions are re-read and
 * compared, not on every render of the row. A resize of the container moves
 * slots without changing the key; the positions are re-read then without
 * animating, so the next reorder glides from where the slots really are.
 */
export function useTabFlip(
  containerRef: React.RefObject<HTMLElement | null>,
  axis: DragAxis,
  skipId: string | null,
  layoutKey: string,
): void {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (root === null) return;
    const g = AXES[axis];
    const prev = positions.current;
    const next = new Map<string, number>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = el.dataset["flipId"];
      if (id === undefined) continue;
      const start = g.start(el);
      next.set(id, start);
      if (id === skipId) continue;
      const p = prev.get(id);
      if (p === undefined) {
        if (prev.size > 0) {
          el.animate(
            [
              { opacity: 0, transform: "scale(0.96)" },
              { opacity: 1, transform: "scale(1)" },
            ],
            { duration: 160, easing: "ease-out" },
          );
        }
        continue;
      }
      const delta = p - start;
      if (Math.abs(delta) < 0.5) continue;
      el.animate([{ transform: g.translate(delta, 0) }, { transform: g.translate(0, 0) }], {
        duration: skipId === null ? 280 : 190,
        easing: SETTLE_EASING,
      });
    }
    positions.current = next;
  }, [containerRef, axis, skipId, layoutKey]);
  useEffect(() => {
    const root = containerRef.current;
    if (root === null || typeof ResizeObserver === "undefined") return;
    const g = AXES[axis];
    const observer = new ResizeObserver(() => {
      positions.current = readSlotStarts(root, g);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [containerRef, axis]);
}

/**
 * What the row LAYS OUT from while a drag is live: everything here changes
 * `view` or the dragged slot's styling, so a new one means a render. The
 * slot's position along the row and its lift change every frame and stay
 * inside the gesture (see `beginPress`), written straight onto the slot and
 * the layer's ghost.
 */
export interface TabDrag {
  id: string;
  /** Where along the slot it was grabbed, in layout px. */
  grabOffset: number;
  /** Layout centers of every slot in visual order, frozen when the drag began. */
  slots: Array<{ id: string; center: number }>;
  fromIndex: number;
  toIndex: number;
  /** The pointer has crossed into the content box: the row stops reordering. */
  overContent: boolean;
  /**
   * The drag layer draws the slot and the slot itself is transparent: its
   * far edge has reached the page, which paints over it, or the pointer is
   * over the page. Sticky for the gesture so it never flickers at the edge.
   */
  lifted: boolean;
  zone: SplitZone | null;
  /**
   * Released and committed, but main has not published the new order yet:
   * `view` keeps the drop's order so the slots do not snap back to the old
   * one and FLIP forward again. The pointer no longer positions the slot.
   */
  settling: boolean;
  rowMin: number;
  rowMax: number;
  winMin: number;
  winMax: number;
  maxLift: number;
}

export interface TabDragOptions {
  axis: DragAxis;
  /** The FLIP container: every slot is a direct `[data-flip-id]` child, the tail included. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** The row in its settled order — a split group is ONE item. */
  items: RowItem[];
  /**
   * Viewport box of the page the split zones mirror, read once as a press
   * begins (so the row need not re-render on every surface layout pass).
   * null disables lift and split-by-drag: the slot is clamped to the row and
   * only reorders.
   */
  contentBounds(): ContentBounds | null;
}

export interface TabDragHandle {
  drag: TabDrag | null;
  /** `items` with the dragged one at the index a drop would commit right now. */
  view: RowItem[];
  /** Wire to each slot's onPointerDown. */
  beginPress(item: RowItem, e: React.PointerEvent<HTMLElement>): void;
  /** True once a press turned into a drag: the click that ends it must not select. */
  justDragged(): boolean;
}

function slotOf(g: AxisGeometry, el: HTMLElement): { id: string; center: number } {
  return { id: el.dataset["flipId"] ?? "", center: g.start(el) + g.size(el) / 2 };
}

function queryFlip(root: HTMLElement | null, id: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(id)}"]`) ?? null;
}

/** Two drags the row would lay out identically. */
function sameTabDrag(a: TabDrag, b: TabDrag): boolean {
  return (
    a.id === b.id &&
    a.toIndex === b.toIndex &&
    a.zone === b.zone &&
    a.lifted === b.lifted &&
    a.overContent === b.overContent &&
    a.settling === b.settling
  );
}

/** The live gesture's hooks for the row's commit-time effect. */
interface LiveGesture {
  /** Re-place the dragged slot against the layout the row just committed. */
  follow(current: TabDrag): void;
}

/**
 * Drag a slot along the row to reorder it, lift it out of the row to split.
 * Owns the FLIP of the other slots, the dragged slot's transform, the
 * transparent drag-capture layer, and the reorder/split commit on release.
 */
export function useTabDrag({ axis, containerRef, items, contentBounds }: TabDragOptions): TabDragHandle {
  const g = AXES[axis];
  const [drag, setDrag] = useState<TabDrag | null>(null);

  const others = items.filter((i) => i.id !== drag?.id);
  // While dragging, the row renders the drop it would commit right now.
  const view =
    drag === null
      ? items
      : (() => {
          const dragged = items.find((i) => i.id === drag.id);
          if (dragged === undefined) return items;
          const next = [...others];
          next.splice(drag.toIndex, 0, dragged);
          return next;
        })();

  // The pointer positions the dragged slot only while the gesture is live;
  // once it settles, layout owns it like every other slot. The slots size
  // themselves from the row (flex), so what lays the row out is which slots
  // are in it, in what order, which is active, and how many panes each holds.
  useTabFlip(
    containerRef,
    axis,
    drag !== null && !drag.settling ? drag.id : null,
    view.map((i) => `${i.id}${i.active ? "*" : ""}:${i.tabs.length}`).join("|"),
  );

  const elFor = (id: string): HTMLElement | null => queryFlip(containerRef.current, id);

  const layoutOrigin = (): number => {
    const parent = containerRef.current?.offsetParent;
    return parent instanceof HTMLElement ? g.origin(parent.getBoundingClientRect()) : 0;
  };

  const dropIndexFor = (state: TabDrag, position: number): number => {
    const el = elFor(state.id);
    if (el === null) return state.toIndex;
    const max = state.slots.length - 1;
    if (position >= state.rowMax - 0.5) return max;
    if (position <= state.rowMin + 0.5) return 0;
    const center = position + g.size(el) / 2;
    const passed = state.slots.filter((s) => s.id !== state.id && s.center < center).length;
    return Math.min(Math.max(passed, 0), max);
  };

  // Set true once a press turns into a real drag, so the click that follows
  // pointerup drops instead of selecting the slot under it.
  const draggedRef = useRef(false);
  // Set by each beginPress and read only while that drag is live.
  const gestureRef = useRef<LiveGesture | null>(null);

  const beginPress = (item: RowItem, e: React.PointerEvent<HTMLElement>): void => {
    // Left button only, and never from a control inside the slot — those own
    // their own gestures. The address field is the exception (data-drag-handle).
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const control = e.target.closest("button");
    if (control instanceof HTMLElement && control.dataset["dragHandle"] === undefined) return;
    const container = containerRef.current;
    const el = elFor(item.id);
    if (container === null || el === null) return;
    draggedRef.current = false;

    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = el.getBoundingClientRect();
    const grabX = startX - startRect.left;
    const grabY = startY - startRect.top;
    const startLift = g.lift(e);
    const grabOffset = g.along(e) - layoutOrigin() - g.start(el);
    const area = contentBounds();
    const tabsBySlot = new Map(items.map((i) => [i.id, i.tabs.map((t) => t.id)]));
    // A split is already both panes: there is nowhere for it to be dropped.
    const canSplit = item.tabs.length === 1 && (useAppStore.getState().snapshot?.visibleTabIds.length ?? 0) < 4;
    /** What the row lays out from; `setDrag` sees it only when it changes. */
    let state: TabDrag | null = null;
    /** The dragged slot's leading edge along the row (layout px, clamped) and its lift, as of the latest frame. */
    let position = 0;
    let lift = 0;
    /** The layer is drawing the ghost — the last visual sent was not null. */
    let visualShown = false;
    let finished = false;
    let offSample = (): void => {};

    const zoneFor = (ev: PointerLike): SplitZone | null =>
      !canSplit || area === null ? null : splitZoneAt(axis, area, ev);

    // The slot's own limits, for the layer's ghost: along the row it is held
    // to the row (or, over the page, the window) as `position` is; along the
    // lift it never rises back above where it started or leaves the window.
    const clampFor = (current: TabDrag): TabDragClamp => {
      const origin = layoutOrigin();
      const along = {
        min: origin + (current.overContent ? current.winMin : current.rowMin),
        max: origin + (current.overContent ? current.winMax : current.rowMax),
      };
      const liftRange = { min: g.liftStart(startRect), max: g.liftStart(startRect) + current.maxLift };
      return axis === "x"
        ? { minLeft: along.min, maxLeft: along.max, minTop: liftRange.min, maxTop: liftRange.max }
        : { minTop: along.min, maxTop: along.max, minLeft: liftRange.min, maxLeft: liftRange.max };
    };

    // The dragged slot is positioned by the pointer, not by layout. Once a
    // drop would split, it also shrinks and fades toward the grab point.
    // Measured against the slot's layout start, so it is re-placed after
    // every layout the row commits (the layout effect below) as well as on
    // every pointer frame.
    const follow = (current: TabDrag): void => {
      const target = elFor(current.id);
      if (target === null) return;
      const start = g.start(target);
      const armed = current.zone !== null;
      target.style.transformOrigin = g.transformOrigin(current.grabOffset);
      target.style.transform = `${g.translate(position - start, lift)} scale(${armed ? 0.9 : 1})`;
      target.style.opacity = current.lifted ? "0" : armed ? "0.9" : "";
    };

    const onMove = (ev: PointerLike): void => {
      if (state === null) {
        if (Math.abs(ev.clientX - startX) < DRAG_START_PX && Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
        const slots = [...container.querySelectorAll<HTMLElement>("[data-flip-id]")]
          .filter((node) => node.dataset["flipId"] !== NEW_TAB_FLIP_ID)
          .map((node) => slotOf(g, node));
        const fromIndex = slots.findIndex((s) => s.id === item.id);
        if (fromIndex < 0) return;
        const tailEl = container.querySelector<HTMLElement>(`[data-flip-id="${NEW_TAB_FLIP_ID}"]`);
        const rowMin = g.start(container);
        const rowMax = Math.max(rowMin, (tailEl === null ? rowMin + g.size(container) : g.start(tailEl)) - g.size(el));
        const origin = layoutOrigin();
        const winMin = -origin;
        const winMax = Math.max(winMin, winMin + g.window() - g.size(el));
        state = {
          id: item.id,
          grabOffset,
          slots,
          fromIndex,
          toIndex: fromIndex,
          overContent: false,
          lifted: false,
          zone: null,
          settling: false,
          rowMin,
          rowMax,
          winMin,
          winMax,
          maxLift: Math.max(0, g.liftRoom(el.getBoundingClientRect())),
        };
        position = rowMin;
        draggedRef.current = true;
        const store = useAppStore.getState();
        store.setTabDragging(true);
        const dragTab = item.tabs[0];
        if (dragTab !== undefined) {
          store.setSplitDragTab({ title: dragTab.title, url: dragTab.url, faviconUrl: dragTab.faviconUrl });
        }
        nativeApi()?.setDragCapture("grabbing");
      }
      // Every measurement first, then the writes.
      const overContent = canSplit && area !== null && g.lift(ev) >= g.areaLiftStart(area);
      position = Math.min(
        Math.max(g.along(ev) - layoutOrigin() - grabOffset, overContent ? state.winMin : state.rowMin),
        overContent ? state.winMax : state.rowMax,
      );
      const zone = zoneFor(ev);
      lift = canSplit ? Math.min(Math.max(g.lift(ev) - startLift, 0), state.maxLift) : 0;
      // The page paints over the slot from the tab view's near edge on: once
      // the slot's far edge passes it the layer draws the slot instead.
      const lifted =
        state.lifted ||
        overContent ||
        (canSplit && area !== null && g.liftEnd(startRect) + lift > g.areaLiftStart(area) + SURFACE_INSET);
      const next: TabDrag = {
        ...state,
        overContent,
        lifted,
        zone,
        toIndex: overContent ? state.fromIndex : dropIndexFor(state, position),
      };
      const clamp = lifted ? clampFor(next) : undefined;

      follow(next);
      useAppStore.getState().setSplitDropZone(zone);
      const tab = item.tabs[0];
      if (lifted && tab !== undefined) {
        nativeApi()?.setTabDragVisual({
          x: ev.clientX,
          y: ev.clientY,
          grabX,
          grabY,
          width: startRect.width,
          height: startRect.height,
          title: tab.title,
          url: tab.url,
          faviconUrl: tab.faviconUrl,
          zone,
          clamp,
        });
        visualShown = true;
      } else if (visualShown) {
        nativeApi()?.setTabDragVisual(null);
        visualShown = false;
      }
      // The row re-renders only for a change it would draw differently.
      const changed = !sameTabDrag(state, next);
      state = next;
      if (changed) setDrag(next);
    };

    // Both pointer sources — the window's own moves and the layer's relayed
    // samples — land on one animation frame, so `onMove` runs at most once a
    // frame with the latest sample (lib/pane-drag.ts does the same).
    let frame = 0;
    let pending: PointerLike | null = null;
    const apply = (): void => {
      frame = 0;
      const sample = pending;
      pending = null;
      if (sample !== null && !finished) onMove(sample);
    };
    const schedule = (ev: PointerLike): void => {
      pending = { clientX: ev.clientX, clientY: ev.clientY };
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    const finish = (commit: boolean): void => {
      if (finished) return;
      // A sample still waiting for its frame is where the pointer let go:
      // the drop is read from it, not from the frame before.
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (pending !== null) {
        const last = pending;
        pending = null;
        onMove(last);
      }
      finished = true;
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      offSample();
      if (visualShown) {
        nativeApi()?.setTabDragVisual(null);
        visualShown = false;
      }
      nativeApi()?.setDragCapture(null);
      const done = state;
      const store = useAppStore.getState();
      if (done === null) {
        store.setTabDragging(false);
        return;
      }
      const dragged = elFor(done.id);
      if (dragged !== null) {
        const delta = position - g.start(dragged);
        dragged.style.transform = "";
        dragged.animate([{ transform: g.translate(delta, lift) }, { transform: g.translate(0, 0) }], {
          duration: 170,
          easing: SETTLE_EASING,
        });
      }
      if (commit && done.zone !== null) {
        const zone = done.zone;
        const id = done.id;
        setDrag(null);
        // Keep the proposed layout in place until main publishes the committed
        // group, avoiding a one-pane flash between pointerup and the IPC reply.
        void store.splitWith(id, zone).finally(() => store.setTabDragging(false));
        return;
      }
      store.setTabDragging(false);
      const moved = commit && done.toIndex !== done.fromIndex;
      const rest = done.slots.filter((s) => s.id !== done.id);
      const anchorAfter = done.toIndex > 0 ? rest[done.toIndex - 1]?.id : undefined;
      const anchorBefore = done.toIndex === 0 ? rest[0]?.id : undefined;
      const after = anchorAfter === undefined ? undefined : tabsBySlot.get(anchorAfter)?.at(-1);
      const before = anchorBefore === undefined ? undefined : tabsBySlot.get(anchorBefore)?.[0];
      const draggedIds = tabsBySlot.get(done.id) ?? [done.id];
      const [head, ...tail] = draggedIds;
      const liveTabs = (): BrowserTabInfo[] => useAppStore.getState().snapshot?.tabs ?? [];
      const live = head === undefined ? [] : liveTabs().filter((t) => t.id !== head);
      const index =
        after !== undefined
          ? live.findIndex((t) => t.id === after) + 1
          : before !== undefined
            ? live.findIndex((t) => t.id === before)
            : -1;
      if (!moved || head === undefined || index < 0) {
        setDrag(null);
        return;
      }
      // Keep the drop's order up while main commits it. Clearing the drag
      // here would render the row in its CURRENT order for a frame — every
      // slot snapping back — and FLIP them forward again when the reordered
      // snapshot lands. Main publishes that snapshot before it answers, so by
      // the time the reorder resolves the row already draws this order.
      const settling: TabDrag = { ...done, settling: true };
      setDrag(settling);
      const settle = (): void => setDrag((current) => (current === settling ? null : current));
      const timeout = window.setTimeout(settle, SETTLE_TIMEOUT_MS);
      void (async () => {
        await store.reorderTab(head, index);
        // A split lands as a contiguous run: each following tab goes directly
        // after the one before it, re-read from the live order every time.
        let prev = head;
        for (const id of tail) {
          const without = liveTabs().filter((t) => t.id !== id);
          const at = without.findIndex((t) => t.id === prev);
          if (at < 0) break;
          await store.reorderTab(id, at + 1);
          prev = id;
        }
      })().finally(() => {
        window.clearTimeout(timeout);
        settle();
      });
    };
    const onWindowMove = (ev: PointerEvent): void => schedule(ev);
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);

    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    offSample = nativeApi()?.onDragSample((sample) => {
      if (sample.phase !== "cancel") schedule({ clientX: sample.x, clientY: sample.y });
      if (sample.phase === "up") finish(true);
      else if (sample.phase === "cancel") finish(false);
      // On a stream surface nothing relays OS samples: the pointer events the
      // window already gets carry the whole gesture (§10).
    }) ?? offSample;

    gestureRef.current = { follow };
  };

  // After every layout the row commits for the drag, the dragged slot's own
  // layout start may have moved (the others reflowed around the new drop):
  // place it against the new start. The pointer-only frames between commits
  // are the gesture's own (`onMove`).
  useLayoutEffect(() => {
    if (drag === null || drag.settling) return;
    gestureRef.current?.follow(drag);
    const el = queryFlip(containerRef.current, drag.id);
    return () => {
      if (el === null) return;
      el.style.transformOrigin = "";
      el.style.opacity = "";
    };
  }, [containerRef, drag]);

  return { drag, view, beginPress, justDragged: () => draggedRef.current };
}
