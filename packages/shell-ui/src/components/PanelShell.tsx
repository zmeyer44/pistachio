/**
 * The agent console's shell: the open/close slide and the resize handle.
 *
 * The panel is a flex SIBLING of the content hole, not an overlay: it takes
 * real layout width, the hole narrows, and main resizes the tab views onto
 * the smaller region (BrowserSurface reports it). The panel outlives `open`
 * by one animation — it mounts collapsed and expands on the next frame, and
 * on close it collapses first and unmounts when the slide lands.
 *
 * `animating` gates the width transition (`.panel-slide` in styles.css), so a
 * resize drag — which is not an open/close — tracks the pointer exactly.
 * OPEN_MS / CLOSE_MS must match that class's durations: the close timer is
 * what unmounts the panel.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "../lib/panel";
import { useAppStore } from "../store";
import { ResizeHandle } from "./ResizeHandle";

const OPEN_MS = 220;
const CLOSE_MS = 160;

export function PanelShell({
  open,
  label,
  children,
  ...rest
}: {
  open: boolean;
  label: string;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  // The width is read here, not by the panel's owner: a resize drag sets it
  // every frame, and only the shell's own boxes need to follow.
  const width = useAppStore((s) => s.consoleWidth);
  const setConsoleWidth = useAppStore((s) => s.setConsoleWidth);
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [animating, setAnimating] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    // A session that starts with the console open shows it; it does not play
    // an opening animation at launch.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (open) {
      setMounted(true);
      setAnimating(true);
      // Two frames: the collapsed width has to be painted before the expanded
      // one is set, or the browser coalesces both into one style change and
      // there is nothing to transition from.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      const settle = window.setTimeout(() => setAnimating(false), OPEN_MS + 60);
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        window.clearTimeout(settle);
      };
    }
    setAnimating(true);
    setExpanded(false);
    const settle = window.setTimeout(() => {
      setMounted(false);
      setAnimating(false);
    }, CLOSE_MS);
    return () => window.clearTimeout(settle);
  }, [open]);

  if (!mounted) return null;

  return (
    <aside
      {...rest}
      aria-label={label}
      // On its way out it should take no clicks and no tab stops.
      inert={open ? undefined : true}
      data-closing={open ? undefined : ""}
      // The store clamps every width it stores, so no min/max here — a min
      // would pin the collapsed end of the slide open.
      style={{ width: expanded ? width : 0 }}
      className={cn("relative z-2 h-full shrink-0", animating && "panel-slide")}
    >
      {open ? (
        <ResizeHandle
          side="left"
          width={width}
          min={PANEL_MIN_WIDTH}
          max={PANEL_MAX_WIDTH}
          defaultWidth={PANEL_DEFAULT_WIDTH}
          label="Resize agent console"
          setWidth={setConsoleWidth}
        />
      ) : null}
      {/* The clip box takes the animating width; the panel inside keeps its
          full width the whole way, so it slides in as one piece rather than
          reflowing at every intermediate width. The border and fill live on
          the panel, not the clip box, so its left edge travels with it. */}
      <div className="h-full w-full overflow-hidden">
        <div
          data-testid="agent-panel-surface"
          style={{ width }}
          // The column is spelled out as minmax(0,1fr) for the same reason the
          // rows are: an implicit `auto` track sizes to its content's
          // max-content width and ignores the panel's own width, so one long
          // URL in the thread would widen the track and push everything past
          // the clip box — text cut mid-word at the panel's edge.
          className="chrome-panel-surface grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)] border-l border-alpha-400 bg-background-100"
        >
          {children}
        </div>
      </div>
    </aside>
  );
}
