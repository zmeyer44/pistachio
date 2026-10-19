/**
 * Pings over the stage (docs/live-share.md §1): a ripple in the pinger's
 * colour where they double-clicked or ⌥-clicked. Each one is a node of its
 * own, taken down when its animation is over (`MarkPile`: at most 48 up).
 */

import { useEffect, useRef } from "react";
import type { Emitter } from "./emitter.js";
import type { LivePingEvent } from "./hooks.js";
import { MarkPile } from "./mark-pile.js";
import type { StageBoxSource } from "./stage-box.js";

export interface PingLayerProps {
  feed: Emitter<LivePingEvent>;
  box: StageBoxSource;
  className?: string;
}

/** Longer than the ripple's animation, for a tab in the background where animations do not end. */
const PING_LIFE_MS = 1600;

export function PingLayer({ feed, box, className }: PingLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const pile = new MarkPile<HTMLElement>(PING_LIFE_MS);
    const off = feed.on(({ x, y, color }) => {
      const stage = box.get();
      const ping = document.createElement("div");
      ping.className = "lv-ping";
      ping.style.setProperty("--lv-ping-color", color);
      ping.style.transform = `translate3d(${(stage.x + x * stage.w).toFixed(1)}px, ${(stage.y + y * stage.h).toFixed(1)}px, 0)`;
      ping.innerHTML = '<span class="lv-ping-ring"></span><span class="lv-ping-ring"></span><span class="lv-ping-dot"></span>';
      root.append(ping);
      pile.add(ping);
    });
    return () => {
      off();
      pile.clear();
    };
  }, [feed, box]);

  return <div ref={rootRef} className={["lv-layer", "lv-pings", className].filter(Boolean).join(" ")} aria-hidden="true" />;
}
