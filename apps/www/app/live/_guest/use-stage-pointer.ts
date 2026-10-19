/**
 * The guest's own pointer over the stage (docs/live-share.md §1, §9): never
 * drawn here — it is the system's — but sent as `lv.cursor`, throttled, from
 * every move over what is visible of the stage, with the tool in hand and
 * whether it is pressed; and pings, with the pointer tool: ⌥-click anywhere
 * on the stage (before a window's hands can take it), or a double-click
 * anywhere but a page in hand (it is the page's) or a window's label (it
 * fills the view).
 */

import { useEffect, type RefObject } from "react";
import { CursorThrottle, type LiveTool } from "@pistachio/live-share";
import type { LiveRoom } from "@pistachio/live-share/room";
import type { StageController } from "./stage-controller";

export interface StagePointerOptions {
  room: LiveRoom;
  controller: StageController;
  /** The element the controller lays the stage out in. */
  area: RefObject<HTMLElement | null>;
  tool: { readonly current: LiveTool };
  ping(x: number, y: number): void;
  /** Whether a window takes the guest's input now. */
  usable(windowId: string): boolean;
}

export function useStagePointer({ room, controller, area: areaRef, tool, ping, usable }: StagePointerOptions): void {
  useEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    const throttle = new CursorThrottle({
      send: (cursor) => {
        room.send("lv.cursor", cursor).catch(() => undefined);
      },
      stageSize: () => controller.frame()?.stage ?? { w: 1, h: 1 },
    });

    /** A client point as stage-normalized (clamped), and whether it is over what is visible of the stage. */
    const stagePointOf = (event: MouseEvent): { x: number; y: number; inside: boolean } | null => {
      const layout = controller.layout();
      if (layout === null || layout.view.w <= 0 || layout.view.h <= 0) return null;
      const rect = area.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const { visible, view } = layout;
      const inside = px >= visible.x && px <= visible.x + visible.w && py >= visible.y && py <= visible.y + visible.h;
      const clamp = (value: number): number => Math.min(1, Math.max(0, value));
      return { x: clamp((px - view.x) / view.w), y: clamp((py - view.y) / view.h), inside };
    };

    const track = (event: PointerEvent): void => {
      const point = stagePointOf(event);
      const down = (event.buttons & 1) === 1;
      throttle.update(point?.inside === true ? { x: point.x, y: point.y, tool: tool.current, ...(down ? { down } : {}) } : null, performance.now());
    };
    const leave = (): void => throttle.update(null, performance.now());
    const altPress = (event: PointerEvent): void => {
      if (!event.altKey || event.button !== 0 || tool.current !== "pointer") return;
      const point = stagePointOf(event);
      if (point === null || !point.inside) return;
      event.preventDefault();
      event.stopPropagation();
      ping(point.x, point.y);
    };
    const doubleClick = (event: MouseEvent): void => {
      if (tool.current !== "pointer") return;
      const target = event.target as Element;
      if (target.closest(".lvg-window-tab") !== null) return;
      const window = target.closest<HTMLElement>("[data-window]");
      if (window !== null && usable(window.dataset["window"] ?? "")) return;
      const point = stagePointOf(event);
      if (point !== null && point.inside) ping(point.x, point.y);
    };

    area.addEventListener("pointermove", track);
    area.addEventListener("pointerdown", track);
    area.addEventListener("pointerup", track);
    area.addEventListener("pointerleave", leave);
    area.addEventListener("pointerdown", altPress, true);
    area.addEventListener("dblclick", doubleClick);
    return () => {
      area.removeEventListener("pointermove", track);
      area.removeEventListener("pointerdown", track);
      area.removeEventListener("pointerup", track);
      area.removeEventListener("pointerleave", leave);
      area.removeEventListener("pointerdown", altPress, true);
      area.removeEventListener("dblclick", doubleClick);
      throttle.dispose();
    };
  }, [room, controller, areaRef, tool, ping, usable]);
}
