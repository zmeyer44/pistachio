/**
 * Everyone else's pointer over the stage (docs/live-share.md §1, §9): an
 * arrow in their colour with a white edge and their name in a pill, or a dot
 * while they hold a pen. One frame loop, running only while a pointer glides
 * or fades — at rest, a timer wakes it when a still pointer begins to fade —
 * and each pointer is a node of its own moved by transform. React
 * renders the empty layer once — who is in the room only relabels the nodes.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import type { CursorFeed } from "./cursor-feed.js";
import type { StageBoxSource } from "./stage-box.js";

export interface CursorPerson {
  name: string;
  color: string;
}

export interface CursorLayerProps {
  feed: CursorFeed;
  /** Name and colour by identity. A pointer whose owner is unknown yet draws in grey, unnamed. */
  people: ReadonlyMap<string, CursorPerson>;
  box: StageBoxSource;
  className?: string;
}

/** The macOS arrow, tip at (0, 0) of its box: a fill in the person's colour under a white edge. */
const ARROW = `<svg class="lv-cursor-arrow" width="22" height="24" viewBox="-1.5 -1.5 22 24" aria-hidden="true"><path d="M0.6 0.6 L0.6 16.9 L4.6 13.2 L7.4 19.6 L10.4 18.3 L7.7 12.0 L13.2 12.0 Z" fill="currentColor" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke"/></svg>`;

interface CursorNode {
  element: HTMLDivElement;
  name: HTMLSpanElement;
  tool: string;
  down: boolean;
}

function label(node: CursorNode, person: CursorPerson | undefined): void {
  node.element.style.setProperty("--lv-cursor-color", person?.color ?? "#8B8D98");
  node.name.textContent = person?.name ?? "";
  node.name.hidden = person === undefined;
}

export function CursorLayer({ feed, people, box, className }: CursorLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, CursorNode>());
  const peopleRef = useRef(people);

  useLayoutEffect(() => {
    peopleRef.current = people;
    for (const [identity, node] of nodes.current) label(node, people.get(identity));
  }, [people]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const map = nodes.current;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const create = (identity: string): CursorNode => {
      const element = document.createElement("div");
      element.className = "lv-cursor";
      element.dataset["cursor"] = identity;
      element.innerHTML = `${ARROW}<span class="lv-cursor-dot"></span>`;
      const name = document.createElement("span");
      name.className = "lv-cursor-name";
      element.append(name);
      const node: CursorNode = { element, name, tool: "", down: false };
      label(node, peopleRef.current.get(identity));
      root.append(element);
      map.set(identity, node);
      return node;
    };

    const draw = (): void => {
      frame = 0;
      const now = performance.now();
      const stage = box.get();
      const shown = new Set<string>();
      for (const cursor of feed.smoother.sample(now)) {
        shown.add(cursor.id);
        const node = map.get(cursor.id) ?? create(cursor.id);
        const x = stage.x + cursor.x * stage.w;
        const y = stage.y + cursor.y * stage.h;
        node.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        node.element.style.opacity = cursor.opacity >= 1 ? "" : cursor.opacity.toFixed(3);
        if (node.tool !== cursor.tool) {
          node.tool = cursor.tool;
          node.element.dataset["tool"] = cursor.tool;
        }
        if (node.down !== cursor.down) {
          node.down = cursor.down;
          node.element.toggleAttribute("data-down", cursor.down);
        }
      }
      for (const [identity, node] of map) {
        if (shown.has(identity)) continue;
        node.element.remove();
        map.delete(identity);
      }
      if (feed.smoother.animating(now)) {
        frame = requestAnimationFrame(draw);
        return;
      }
      // Every pointer at rest: no frames until one starts to fade (or a sample comes).
      const next = feed.smoother.nextChange(now);
      if (next !== null) timer = setTimeout(wake, next - now);
    };
    const wake = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (frame === 0) frame = requestAnimationFrame(draw);
    };

    const offFeed = feed.onWake(wake);
    const offBox = box.subscribe(wake);
    wake();
    return () => {
      offFeed();
      offBox();
      cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      for (const node of map.values()) node.element.remove();
      map.clear();
    };
  }, [feed, box]);

  return <div ref={rootRef} className={["lv-layer", "lv-cursors", className].filter(Boolean).join(" ")} aria-hidden="true" />;
}
