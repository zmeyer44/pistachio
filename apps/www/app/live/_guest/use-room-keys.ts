/**
 * The room's keys (docs/live-share.md §1 In the room): M microphone, V
 * camera, P pointer, D pen, H highlighter, L laser, Escape back to the desk
 * (from a filled window) or to the pointer, ⌘/ chat. Never while the person
 * types — in a field, or into a window that has their keyboard (its own
 * handler takes every key first).
 */

import { useEffect, useRef } from "react";
import type { LiveTool } from "@pistachio/live-share";

export interface RoomKeys {
  toggleMicrophone(): void;
  toggleCamera(): void;
  chooseTool(tool: LiveTool): void;
  toggleChat(): void;
  /** Escape: true when it was used (a filled window let go); otherwise the pointer comes back. */
  escape(): boolean;
}

/** A map, not an object: no key the browser names finds what every object inherits. */
const TOOL_KEYS: ReadonlyMap<string, LiveTool> = new Map([["p", "pointer"], ["d", "pen"], ["h", "highlighter"], ["l", "laser"]]);

export function useRoomKeys(keys: RoomKeys): void {
  const latest = useRef(keys);
  useEffect(() => {
    latest.current = keys;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const actions = latest.current;
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        actions.toggleChat();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']") != null) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      const tool = TOOL_KEYS.get(key);
      if (tool !== undefined) actions.chooseTool(tool);
      else if (key === "m") actions.toggleMicrophone();
      else if (key === "v") actions.toggleCamera();
      else if (key === "escape") {
        if (!actions.escape()) actions.chooseTool("pointer");
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
