import { useEffect, useRef } from "react";
import type { GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import { LIVE_SHELL_MARKS, type LiveRect } from "@pistachio/shell-contracts/live-share";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { nativeApi } from "../../api";
import { documentWindowIds } from "../../lib/desk/documents";
import { deskGroups, useDeskStore } from "../../lib/desk/store";
import { isTabWindow } from "../../lib/desk/windows";
import { deskReport, layersCover, layersOverStage, LiveDeskPacer, tooltipBands, type BodyLayer, type LiveWindowKind } from "../../lib/live/desk-report";
import { MARK_ELEMENT_ID, ShellMarkPainter } from "../../lib/live/marker";
import { useLiveShare } from "../../lib/live/store";
import { useAppStore } from "../../store";
import type { DeskEngine } from "../desk/desk-engine";

/** The element the app is mounted in (the renderer's index.html); anything else in `<body>` is a layer of its own. */
const APP_ROOT_ID = "root";
/** The document's own furniture, never drawn. */
const UNDRAWN = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);
/** Where the last mark the shell painted is kept for its next page: a reload goes on counting, and never repeats a number. */
const MARK_KEY = "pistachio.live.mark";

/** The mark to count on from: after the last one this page (or the one before it, reloaded) painted. */
function firstMark(): number {
  try {
    const stored = window.sessionStorage.getItem(MARK_KEY);
    const last = stored === null ? Number.NaN : Number(stored);
    if (Number.isInteger(last) && last >= 0 && last < LIVE_SHELL_MARKS) return (last + 1) % LIVE_SHELL_MARKS;
  } catch {
    // (No storage: a number of its own.)
  }
  return Math.floor(Math.random() * LIVE_SHELL_MARKS);
}

function rememberMark(mark: number): void {
  try {
    window.sessionStorage.setItem(MARK_KEY, String(mark));
  } catch {
    // (Counting on from a number of its own next time does as well, all but surely.)
  }
}

/** `<body>`'s layers beside the app's root and the mark: each a tooltip's box (its popups', as laid out now), or nothing known. */
function bodyLayers(): BodyLayer[] {
  const layers: BodyLayer[] = [];
  for (const child of document.body.children) {
    if (child.id === APP_ROOT_ID || child.id === MARK_ELEMENT_ID || UNDRAWN.has(child.tagName.toUpperCase())) continue;
    const popups = [...child.querySelectorAll('[data-slot="tooltip-content"]')];
    if (popups.length === 0) {
      layers.push({ tooltip: null });
      continue;
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const popup of popups) {
      const rect = popup.getBoundingClientRect();
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    const box: LiveRect = { x: left, y: top, w: right - left, h: bottom - top };
    layers.push({ tooltip: box });
  }
  return layers;
}

/**
 * While a share is live, the desk's report of the shared space to main
 * (lib/live/desk-report.ts): from the engine's own view of it after every
 * render while it is the space in front, or from its saved arrangement while
 * another is; nothing (null) once the share is over. Mounted by the desk
 * (DeskSurface), which hands it its engine and the spaces' contexts (a
 * space's documents are its windows too).
 *
 * The report says too what of the shell's lies over which window (docs/
 * live-share.md §6.6): the engine's covers, each where its owner says; and,
 * over every window, a passing, the store's overlays, and anything put in
 * `<body>` beside the app (a portal) but a tooltip in its band or off the
 * stage. Each is heard as it changes, before it is painted — the engine
 * reports from the render that put a cover up, the store's subscribers hear
 * a change inside the `set` that made it, a mutation observer (on `<body>`,
 * and in each portal: a tooltip placed or moved) runs before the next frame —
 * and a report that covers more goes to main at once. Each report sent is
 * numbered, and its number painted in the shell's corner in the same task
 * (lib/live/marker.ts): the frame that shows what it says says which it is.
 * A render that draws a window elsewhere while its report waits its turn
 * paints that number stale, in the same task: a frame painted then is cut
 * only where nothing has moved.
 */
export function useLiveDeskReport(engine: DeskEngine | null, contexts: readonly GroupContextView[]): void {
  const shared = useLiveShare((state) => (state.status === "live" ? state.groupId : null));
  const contextsRef = useRef(contexts);
  contextsRef.current = contexts;
  const contextsChanged = useRef<(() => void) | null>(null);
  useEffect(() => contextsChanged.current?.(), [contexts]);

  useEffect(() => {
    const api = nativeApi();
    if (engine === null || shared === null || api === null) return;
    const painter = new ShellMarkPainter(document);
    const scheme = (): "light" | "dark" => (document.documentElement.dataset["colorScheme"] === "dark" ? "dark" : "light");
    const pacer = new LiveDeskPacer(
      {
        send: (report) => {
          // (In the task that sends it: the next frame painted is the one this report speaks for.)
          painter.show(report.mark, false, scheme());
          rememberMark(report.mark);
          api.setLiveDesk(report);
        },
        // (In the render that drew a window elsewhere, its report kept back: that frame is not this report's to cut.)
        stale: (mark) => painter.show(mark, true, scheme()),
      },
      {
        now: () => performance.now(),
        later: (run, ms) => {
          const timer = window.setTimeout(run, ms);
          return () => window.clearTimeout(timer);
        },
      },
      firstMark(),
    );
    const kindOf = (windowId: string): LiveWindowKind => {
      if (!isTabWindow(windowId)) return "shell";
      const tab = useAppStore.getState().snapshot?.tabs.find((candidate) => candidate.id === windowId);
      return tab !== undefined && !isShellPageUrl(tab.url) ? "page" : "shell";
    };
    const viewport = (): { w: number; h: number } => ({ w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) });
    // What the saved arrangement was last laid out from: another space's desk renders every frame it moves, and the
    // shared one's is laid out again only when what it is laid out from changed.
    let laidFrom: { saved: object; tabs: unknown; key: string } | null = null;
    const report = (): void => {
      const geometry = engine.liveGeometry();
      if (geometry.stage.w < 1 || geometry.stage.h < 1) return;
      if (geometry.groupId === shared) {
        laidFrom = null;
        // Over every window from outside the desk's covers: a passing, an overlay of the store's, a layer in <body>.
        const covered = geometry.passing || layersCover(useAppStore.getState()) || layersOverStage(bodyLayers(), geometry.stage, tooltipBands(geometry.covers));
        pacer.moving(deskReport({ groupId: shared, stage: geometry.stage, viewport: viewport(), windows: geometry.windows, kindOf, covers: geometry.covers, covered, sent: pacer.sent }, false));
        return;
      }
      // Another space in front: the shared one as it was left. (Never on a desk here: nothing to say, guests keep what they had.)
      const saved = useDeskStore.getState().saved[shared];
      const group = deskGroups(useAppStore.getState().snapshot).find((candidate) => candidate.id === shared);
      if (saved === undefined || group === undefined) return;
      const shellIds = documentWindowIds(contextsRef.current.find((context) => context.groupId === shared));
      const from = { saved, tabs: useAppStore.getState().snapshot?.tabs, key: [group.tabIds.join(" "), shellIds.join(" "), geometry.stage.w, geometry.stage.h].join("|") };
      if (laidFrom !== null && laidFrom.saved === from.saved && laidFrom.tabs === from.tabs && laidFrom.key === from.key) return;
      laidFrom = from;
      const windows = engine.savedGeometry(saved.windows, group.tabIds, shellIds, saved.reserve ?? 0);
      // (The stage shows another space: no picture of the shared one is there to cut.)
      pacer.still(deskReport({ groupId: shared, stage: geometry.stage, viewport: viewport(), windows, kindOf, covers: [], covered: true, sent: pacer.sent }, true));
    };
    const offRendered = engine.onRendered(report);
    // (A window's kind, the space's tabs, its saved arrangement and its documents can change with no render of the desk.)
    const offTabs = useAppStore.subscribe((state, previous) => {
      if (state.snapshot?.tabs !== previous.snapshot?.tabs || state.snapshot?.currentGroupId !== previous.snapshot?.currentGroupId || layersCover(state) !== layersCover(previous)) report();
    });
    // A layer put in <body>, or anything in one changing (a tooltip placed, moved): a mutation observer's records are
    // delivered before the frame the change is painted in. (Each layer's own subtree is watched; the app's is not.)
    const layers = new MutationObserver(() => {
      watchLayers();
      report();
    });
    const watchLayers = (): void => {
      layers.disconnect();
      layers.observe(document.body, { childList: true });
      for (const child of document.body.children) {
        if (child.id !== APP_ROOT_ID && child.id !== MARK_ELEMENT_ID) layers.observe(child, { childList: true, subtree: true, attributes: true, characterData: true });
      }
    };
    watchLayers();
    const offSaved = useDeskStore.subscribe((state, previous) => {
      if (state.saved[shared] !== previous.saved[shared]) report();
    });
    contextsChanged.current = report;
    report();
    return () => {
      offRendered();
      offTabs();
      offSaved();
      layers.disconnect();
      contextsChanged.current = null;
      pacer.dispose();
      painter.remove();
      // (Main keeps the desk guests last saw for a null: the share is over, or this desk is going.)
      api.setLiveDesk(null);
    };
  }, [engine, shared]);
}
