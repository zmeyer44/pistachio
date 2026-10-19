/**
 * Reactions (docs/live-share.md §1): an emoji that floats up from the face of
 * whoever sent it, drifting a little, and fades. The layer covers the page
 * (fixed), since faces sit outside the stage; `originOf` says where a
 * person's face is now, and a reaction from someone without one rises from
 * `fallback`. Each one is a node of its own, taken down when it has faded
 * (`MarkPile`: at most 48 up).
 */

import { useEffect, useRef } from "react";
import type { Emitter } from "./emitter.js";
import type { LiveReactionEvent } from "./hooks.js";
import { MarkPile } from "./mark-pile.js";

export interface ReactionLayerProps {
  feed: Emitter<LiveReactionEvent>;
  /** Where a person's face is, in client px, or null when it is not on screen. */
  originOf(identity: string): { x: number; y: number } | null;
  /** Where a reaction rises from otherwise, in client px. */
  fallback(): { x: number; y: number };
  className?: string;
}

const REACTION_LIFE_MS = 2600;

export function ReactionLayer({ feed, originOf, fallback, className }: ReactionLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const originRef = useRef({ originOf, fallback });
  useEffect(() => {
    originRef.current = { originOf, fallback };
  });

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const pile = new MarkPile<HTMLElement>(REACTION_LIFE_MS);
    const off = feed.on(({ emoji, identity }) => {
      const origin = originRef.current.originOf(identity) ?? originRef.current.fallback();
      const node = document.createElement("span");
      node.className = "lv-reaction";
      node.textContent = emoji;
      // Each one takes its own way up, so a burst of the same emoji reads as a burst.
      node.style.setProperty("--lv-drift", `${(Math.random() * 56 - 28).toFixed(0)}px`);
      node.style.setProperty("--lv-tilt", `${(Math.random() * 24 - 12).toFixed(0)}deg`);
      node.style.left = `${origin.x.toFixed(0)}px`;
      node.style.top = `${origin.y.toFixed(0)}px`;
      root.append(node);
      pile.add(node);
    });
    return () => {
      off();
      pile.clear();
    };
  }, [feed]);

  return <div ref={rootRef} className={["lv-reactions", className].filter(Boolean).join(" ")} aria-hidden="true" />;
}
