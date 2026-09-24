import { Fragment, lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { agentDrivenTabId, agentRingDelayMs } from "@pistachio/shell-contracts/agent-glow";
import { PANE_TOOLBAR_H, SURFACE_GUTTER } from "@pistachio/shell-contracts/chrome";
import type { ContentBounds, ShellSnapshot, SplitGroupInfo } from "@pistachio/shell-contracts/ipc";
import { cn } from "../lib/cn";
import type { PaneSpan } from "../lib/pane-toolbar";
import { startPaneDrag } from "../lib/pane-drag";
import {
  SPLIT_DROP_PREVIEW_ID,
  splitDropPreviewLayout,
  splitLayout,
  type SplitAxis,
  type SplitLayoutNode,
} from "../lib/split-layout";
import { useSettingsCoversConsole } from "../lib/settings-fit";
import { displayHost } from "../lib/url";
import { useAppStore, type AppState } from "../store";
import { isHomeUrl } from "@pistachio/shell-contracts/home";
import { notesUrlId } from "@pistachio/shell-contracts/notes";
import { briefUrlDate } from "@pistachio/shell-contracts/reports";
import { Favicon } from "./Favicon";
import { GlanceOverlay } from "./GlanceOverlay";
import { PanePlaceholder } from "./PanePlaceholder";
import { HomePage } from "./home/HomePage";
import { BriefPage } from "./reports/BriefPage";
import { PaneToolbar } from "./PaneToolbar";
import { StreamFindBar } from "./StreamFindBar";
import { nativeApi } from "../api";
import { useSurface } from "../surface";

// The pages that paint over the surface are opened deliberately and rarely;
// none of them is needed for the first frame, so each is its own chunk.
const SettingsPage = lazy(() => import("./settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const RemindersPage = lazy(() => import("./reminders/RemindersPage").then((m) => ({ default: m.RemindersPage })));
const WatchtowerPage = lazy(() => import("./watchtower/WatchtowerPage").then((m) => ({ default: m.WatchtowerPage })));
const ArchivePage = lazy(() => import("./archive/ArchivePage").then((m) => ({ default: m.ArchivePage })));
const BookmarksPage = lazy(() => import("./bookmarks/BookmarksPage").then((m) => ({ default: m.BookmarksPage })));
const SiteControlsPanel = lazy(() => import("./SiteControlsPanel").then((m) => ({ default: m.SiteControlsPanel })));
const PermissionPromptDialog = lazy(() =>
  import("./PermissionPromptDialog").then((m) => ({ default: m.PermissionPromptDialog })),
);
const SpaceForkDialog = lazy(() => import("./SpaceForkDialog").then((m) => ({ default: m.SpaceForkDialog })));
const ImagePreview = lazy(() => import("./ImagePreview").then((m) => ({ default: m.ImagePreview })));
const LiveViewPage = lazy(() => import("./LiveViewPage").then((m) => ({ default: m.LiveViewPage })));
// The notes pages carry the whole editor — TipTap, its ProseMirror plugins,
// the markdown parser — so that chunk arrives the first time a note is opened
// and never when a web page is.
const NotesPage = lazy(() => import("./notes/NotesPage").then((m) => ({ default: m.NotesPage })));

/**
 * The page area: the browser surface with the settings page over it. Both
 * layouts place this same column beside their chrome (layouts/TopLayout.tsx
 * and the sidebar layout), so it is a layout piece, not a chrome feature.
 */
export function ContentArea() {
  const settingsOpen = useAppStore((state) => state.overlay === "settings");
  const remindersOpen = useAppStore((state) => state.overlay === "reminders");
  const watchtowerOpen = useAppStore((state) => state.overlay === "watchtower");
  const archiveOpen = useAppStore((state) => state.overlay === "archive");
  const spaceId = useAppStore((state) => state.snapshot?.activeSpaceId);
  const bookmarksOpen = useAppStore((state) => state.overlay === "bookmarks");
  const siteControlsOpen = useAppStore((state) => state.overlay === "site");
  const permissionPromptOpen = useAppStore((state) => state.overlay === "permission");
  const spaceForkOpen = useAppStore((state) => state.overlay === "space-fork");
  const imagePreviewOpen = useAppStore((state) => state.overlay === "image-preview");
  const liveViewOpen = useAppStore((state) => state.overlay === "liveView");
  const sidebarLayout = useAppStore((state) => state.settings.layout.mode === "sidebar");
  const consoleWidth = useAppStore((state) => state.consoleWidth);
  const settingsCoversConsole = useSettingsCoversConsole();
  const leading = leadingGutter(sidebarLayout);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* The settings page paints over the surface's panes, inside the same
          inset, so it reads as a page in the hole rather than a sheet
          over the window. The surface stays mounted underneath: its stills
          and layout reporting keep the tab views ready to come back. */}
      <BrowserSurface />
      {/* A window too narrow for the page beside the console lends it the
          console's room (lib/settings-fit.ts): the page reaches over the
          panel, which keeps its state underneath. */}
      {settingsOpen ? (
        <SurfacePage leading={leading} reach={settingsCoversConsole ? consoleWidth : 0}>
          <SettingsPage />
        </SurfacePage>
      ) : null}
      {remindersOpen ? <SurfacePage leading={leading}><RemindersPage /></SurfacePage> : null}
      {watchtowerOpen ? <SurfacePage leading={leading}><WatchtowerPage key={spaceId} /></SurfacePage> : null}
      {archiveOpen ? <SurfacePage leading={leading}><ArchivePage key={spaceId} /></SurfacePage> : null}
      {bookmarksOpen ? <SurfacePage leading={leading}><BookmarksPage /></SurfacePage> : null}
      {siteControlsOpen ? <SurfacePage leading={leading}><SiteControlsPanel /></SurfacePage> : null}
      {/* A site's request is a small dialog over the page's still, not a
          page of its own: the page stays in view and is back untouched
          once the request is answered or the dialog is put down. */}
      {permissionPromptOpen ? <SurfacePage leading={leading} overGlance><PermissionPromptDialog /></SurfacePage> : null}
      {spaceForkOpen ? <SurfacePage leading={leading}><SpaceForkDialog /></SurfacePage> : null}
      {imagePreviewOpen ? <SurfacePage leading={leading}><ImagePreview /></SurfacePage> : null}
      {/* A run in the cloud browser, watched here: the same hole the settings
          page fills, since the tab views must be down for either to be seen. */}
      {liveViewOpen ? <SurfacePage leading={leading}><LiveViewPage /></SurfacePage> : null}
    </div>
  );
}

/**
 * The gutter on the card's LEADING edge. In the sidebar layout the column
 * beside the card already ends with its own padding, and the eye reads the
 * distance from the sidebar's ROWS — the only part of the column that paints
 * — to the card. A gutter here would add to that padding and make the one
 * gap the sidebar side has twice every other edge's, so the surface leaves
 * that side to the sidebar: the card sits against the column, one gutter
 * from its rows. With the compact column away, its hidden slot
 * (SIDEBAR_EDGE_W) is the card's inset instead. The top layout has no column
 * beside the card, so the surface owns all four edges there.
 */
function leadingGutter(sidebarLayout: boolean): number {
  return sidebarLayout ? 0 : SURFACE_GUTTER;
}

/**
 * A page painted in the card's hole, on the surface's own inset. `reach`
 * extends it past the hole's trailing edge by that many pixels — over the
 * console beside it — and lifts it above the panel's own layer.
 */
function SurfacePage({
  leading,
  reach = 0,
  overGlance = false,
  children,
}: {
  leading: number;
  reach?: number;
  /** Stand above a Glance (GlanceOverlay, z-40): what the preview asked is answered over it. */
  overGlance?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("no-drag absolute inset-y-2", reach > 0 && "z-10", overGlance && "z-50")}
      data-reach={reach > 0 ? "console" : undefined}
      style={{ left: leading, right: SURFACE_GUTTER - reach }}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  );
}

/**
 * The rounded card the tab views are laid over, with an 8px gutter around it.
 * It reports the panes' boxes to main (which sizes the tab views to them) and
 * its own box to the store (tab-drag edge geometry reads it).
 *
 * In the sidebar layout the gutter is a drag region: with the sidebar compact
 * nothing else in the window is draggable. That layout's leading edge belongs
 * to the sidebar's column instead (leadingGutter), so the gutter there is
 * three-sided. The panes and the divider opt out, so the page and the resize
 * gesture keep their pointer. The top gutter is
 * also the pane toolbar's reveal target (PaneToolbar): while the row is up
 * the top padding grows to the row's height, and the same reporting below
 * carries the card's slide to main frame by frame.
 *
 * A snapshot is published on every tab event — a title tick, a favicon, a
 * loading edge — and a split doubles that traffic. The surface selects only
 * the pane composition from the store (selectPaneComposition), so it
 * re-renders on those fields alone rather than churning the whole pane tree
 * once per event.
 */
export function BrowserSurface() {
  return <BrowserSurfaceImpl />;
}

/** The snapshot fields the surface actually renders from. */
interface PaneComposition {
  activeTabId: string | null;
  visibleTabIds: readonly string[];
  /** Panes whose woken page has not painted yet: drawn as the tab's mark (WakingPane). */
  wakingTabIds: readonly string[];
  splitGroups: readonly SplitGroupInfo[];
  agentRevision: string;
  /** The pane the ring goes around (@pistachio/shell-contracts/agent-glow), or null. */
  drivenTabId: string | null;
  /** The window has a snapshot and no tabs in it: the surface shows the home page. */
  tabless: boolean;
}

const EMPTY_IDS: readonly string[] = [];
const EMPTY_GROUPS: readonly SplitGroupInfo[] = [];

/**
 * Selected with useShallow: the arrays keep their identity across publishes
 * that did not change them (the store shares structure, lib/share.ts), so a
 * title tick compares equal here and the surface does not render.
 */
function selectPaneComposition(state: AppState): PaneComposition {
  const snapshot = state.snapshot;
  return {
    activeTabId: snapshot?.activeTabId ?? null,
    visibleTabIds: snapshot?.visibleTabIds ?? EMPTY_IDS,
    wakingTabIds: snapshot?.wakingTabIds ?? EMPTY_IDS,
    splitGroups: snapshot?.splitGroups ?? EMPTY_GROUPS,
    agentRevision: agentRevision(snapshot),
    // The ring marks the page the agent is acting on, not the fact that it
    // is busy: it goes around the one pane holding that tab, and around
    // nothing when that tab is not on screen. A cloud run drives a page in
    // the cloud browser, so it names no pane here; its live view carries
    // its own ring (LiveViewPage).
    drivenTabId: agentDrivenTabId(snapshot?.run ?? null),
    tabless: snapshot !== null && snapshot.tabs.length === 0,
  };
}

function agentRevision(snapshot: Pick<ShellSnapshot, "run"> | null): string {
  const run = snapshot?.run ?? null;
  return run === null
    ? "idle"
    : `${run.runId}:${run.control}:${run.status}:${String(run.toolCalls.length)}`;
}

function BrowserSurfaceImpl() {
  const snapshot = useAppStore(useShallow(selectPaneComposition));
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneSpans, setPaneSpans] = useState<readonly PaneSpan[]>([]);
  const paneToolbarRevealed = useAppStore((state) => state.paneToolbarRevealed);
  const setContentBounds = useAppStore((state) => state.setContentBounds);
  const paneStills = useAppStore((state) => state.paneStills);
  const splitDropZone = useAppStore((state) => state.splitDropZone);
  const glance = useAppStore((state) => state.glance);
  const glanceStaged = useAppStore((state) => state.glanceStaged);
  const glanceClosing = useAppStore((state) => state.glanceClosing);
  const sidebarLayout = useAppStore((state) => state.settings.layout.mode === "sidebar");
  const activeGroup = snapshot.activeTabId === null
    ? undefined
    : snapshot.splitGroups.find((group) => group.tabIds.includes(snapshot.activeTabId!));
  // The group owns pane order; activeTabId only identifies which pane has focus.
  const paneTabIds = activeGroup?.tabIds ?? (snapshot.visibleTabIds.length > 0
    ? snapshot.visibleTabIds
    : snapshot.activeTabId === null
      ? []
      : [snapshot.activeTabId]);
  const paneKey = paneTabIds.join(":");
  // Agent-driven tab changes can happen faster than a GPU-backed page paints.
  // Re-report the real DOM geometry at every visible tool/status revision so
  // a late compositor resize can never leave the native page over the chat.
  const agentLayoutRevision = snapshot.agentRevision;
  const drivenTabId = snapshot.drivenTabId;
  const gridLayout = activeGroup?.gridLayout ?? "span-bottom";
  const mode = activeGroup?.mode ?? "vertical";
  const settledLayout = splitLayout(paneTabIds, mode, gridLayout);
  const previewLayout = splitDropZone === null
    ? null
    : splitDropPreviewLayout(paneTabIds, mode, gridLayout, splitDropZone);
  const layout = previewLayout ?? settledLayout;
  const paneIndex = new Map(paneTabIds.map((tabId, index) => [tabId, index]));
  const visibleStills = glance?.backgroundStills ?? paneStills;
  const wakingTabIds = snapshot.wakingTabIds;
  const stillByTab = useMemo(
    () => new Map(visibleStills.map((still) => [still.tabId, still.dataUrl])),
    [visibleStills],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let frame = 0;
    // The same views payload must never be sent twice in a row: main applies
    // every arriving layout to the native tab views, so a duplicate report is
    // a duplicate pass over them. The cache lives only for this effect run —
    // a new pane set, drop zone, or agent revision starts over with a fresh
    // send, which is what keeps main current after it clears its own layout
    // (a Space switch always changes the pane set, so it always re-sends).
    let sentViews = "";
    const report = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      // One read of the card's box for every pane: each read is a forced
      // layout while the panes are mid-reflow.
      const rootRect = root.getBoundingClientRect();
      const views = [...root.querySelectorAll<HTMLElement>("[data-pane-tab-id]")].flatMap((pane) => {
        const tabId = pane.dataset["paneTabId"];
        // Glance visually scales this grid to recess it. getBoundingClientRect
        // includes that transform, so reporting it during the promotion
        // handoff permanently inset the newly promoted native view. Native
        // page placement follows layout geometry, never decorative transforms.
        return tabId === undefined ? [] : [{ tabId, bounds: layoutBounds(pane, root, rootRect) }];
      });
      const payload = views
        .map(({ tabId, bounds }) => `${tabId}:${String(bounds.x)}:${String(bounds.y)}:${String(bounds.width)}:${String(bounds.height)}`)
        .join(" ");
      if (payload !== sentViews) {
        sentViews = payload;
        nativeApi()?.setLayout({ views });
      }
      setContentBounds(rectBounds(rootRect));
      // The toolbar's clusters follow the panes' columns; only a change in
      // those is worth a render, and the slide itself moves none of them.
      const spans = views.map(({ tabId, bounds }) => ({ tabId, left: bounds.x, right: bounds.x + bounds.width }));
      setPaneSpans((current) => sameSpans(current, spans) ? current : spans);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(report);
    };
    report();
    // Observer callbacks already run once per frame, after layout and before
    // paint, so a divider drag or a toolbar slide reports each frame's real
    // geometry with no added latency; deferring to a rAF here would hand the
    // native views last frame's boxes for the whole gesture.
    const observer = new ResizeObserver(report);
    observer.observe(root);
    for (const pane of root.querySelectorAll<HTMLElement>("[data-pane-tab-id]")) observer.observe(pane);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [paneKey, setContentBounds, activeGroup?.mode, gridLayout, splitDropZone, agentLayoutRevision]);

  return (
    <section
      ref={rootRef}
      data-testid="browser-surface"
      data-toolbar={sidebarLayout && paneToolbarRevealed ? "" : undefined}
      className={cn("browser-surface relative flex min-h-0 min-w-0 flex-1 bg-background-200 p-2", sidebarLayout && "drag-region")}
      style={{
        paddingTop: sidebarLayout && paneToolbarRevealed ? PANE_TOOLBAR_H : SURFACE_GUTTER,
        paddingLeft: leadingGutter(sidebarLayout),
      }}
    >
      <PaneToolbar surfaceRef={rootRef} paneTabIds={paneTabIds} spans={paneSpans} />
      <div
        // The owner recedes only once its still is painted and its live view
        // told to go (GlanceOverlay stages this); dimming under a live view
        // would jump when the view finally hid.
        data-glance={glance !== null && glanceStaged ? "" : undefined}
        data-closing={glanceClosing ? "" : undefined}
        data-split-preview={previewLayout === null ? undefined : splitDropZone ?? undefined}
        className="browser-pane-grid flex min-h-0 min-w-0 flex-1"
      >
        {layout === null ? (
          snapshot.tabless ? (
            <div
              data-testid="tabless-home"
              className="no-drag relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-md bg-background-100 shadow-small"
            >
              <HomePage tabId={null} active />
            </div>
          ) : null
        ) : (
          <SplitLayoutView
            key={`${activeGroup?.mode ?? "single"}:${gridLayout}:${paneKey}:${splitDropZone ?? "settled"}`}
            node={layout}
            paneIndex={paneIndex}
            stillByTab={stillByTab}
            wakingTabIds={wakingTabIds}
            drivenTabId={drivenTabId}
          />
        )}
      </div>
      {glance === null ? null : <GlanceOverlay key={glance.tab.id} glance={glance} surfaceRef={rootRef} />}
    </section>
  );
}

function SplitLayoutView({
  node,
  paneIndex,
  stillByTab,
  wakingTabIds,
  drivenTabId,
}: {
  node: SplitLayoutNode;
  paneIndex: ReadonlyMap<string, number>;
  stillByTab: ReadonlyMap<string, string>;
  wakingTabIds: readonly string[];
  drivenTabId: string | null;
}) {
  if (node.kind === "pane") {
    if (node.tabId === SPLIT_DROP_PREVIEW_ID) return <SplitDropPreview />;
    return (
      <SplitPane
        tabId={node.tabId}
        index={paneIndex.get(node.tabId) ?? 0}
        still={stillByTab.get(node.tabId) ?? null}
        waking={wakingTabIds.includes(node.tabId)}
        driven={node.tabId === drivenTabId}
      />
    );
  }
  return (
    <SplitBranch
      node={node}
      paneIndex={paneIndex}
      stillByTab={stillByTab}
      wakingTabIds={wakingTabIds}
      drivenTabId={drivenTabId}
    />
  );
}

/** The proposed new pane. Native views vacate this exact box as the tree reflows. */
function SplitDropPreview() {
  const side = useAppStore((state) => state.splitDropZone);
  const tab = useAppStore((state) => state.splitDragTab);
  if (side === null) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="split-drop-preview"
      data-side={side}
      className="split-drop-preview no-drag relative grid min-h-0 min-w-0 flex-1 place-items-center overflow-hidden rounded-md"
    >
      <div className="split-drop-preview-label flex flex-col items-center gap-3">
        <Favicon
          src={tab?.faviconUrl ?? null}
          seed={displayHost(tab?.url ?? "") || tab?.title || "\u2022"}
          className="size-16 rounded-2xl text-[28px] shadow-menu"
        />
        <span className="text-[12px] font-medium">Drop to split {side}</span>
      </div>
    </div>
  );
}

/**
 * One pane's box. The native tab view is placed over exactly this element
 * (the layout effect above reads `[data-pane-tab-id]`), which is why the
 * agent-control ring hangs on it: the ring is drawn 3px outside the box, in
 * the gutter between panes, so the pane itself must not clip, and the still
 * gets a clipping wrapper of its own.
 */
function SplitPane({
  tabId,
  index,
  still,
  waking,
  driven,
}: {
  tabId: string;
  index: number;
  still: string | null;
  waking: boolean;
  driven: boolean;
}) {
  const testId = index === 0 ? "primary-pane" : index === 1 ? "secondary-pane" : `split-pane-${index + 1}`;
  // On a stream surface the page IS this card's content: there is no native
  // view to place over a hole, so the pane paints the tab itself (§3.2, §10).
  const surface = useSurface();
  const tab = useAppStore(
    (state) => state.snapshot?.tabs.find((candidate) => candidate.id === tabId) ?? null,
  );
  const paneActive = useAppStore((state) => state.snapshot?.activeTabId === tabId);
  const home = tab !== null && isHomeUrl(tab.url);
  // `undefined` when the tab is not a brief; `null` is today's brief.
  const briefDate = tab === null ? undefined : briefUrlDate(tab.url.trim());
  // Same convention: `undefined` is not a notes address, `null` is the library.
  const noteId = tab === null ? undefined : notesUrlId(tab.url.trim());
  return (
    <div
      data-testid={testId}
      data-split-pane=""
      data-pane-tab-id={tabId}
      data-tab-id={tabId}
      data-agent-driving={driven ? "" : undefined}
      data-waking={waking ? "" : undefined}
      className={cn("no-drag relative min-h-0 min-w-0 flex-1 rounded-md bg-background-100 shadow-small", driven && "agent-ring")}
      style={{ "--agent-ring-delay": useAgentRingDelay(driven) } as CSSProperties}
    >
      <div className="absolute inset-0 overflow-hidden rounded-md">
        {home ? (
          // The home page is the shell's own drawing on both surfaces: no
          // native view is shown over this pane and nothing streams into it
          // (@pistachio/shell-contracts/home), so it needs no still either.
          <HomePage tabId={tabId} active={paneActive} />
        ) : briefDate !== undefined ? (
          // The daily brief is shell-drawn the same way
          // (@pistachio/shell-contracts/shell-pages).
          <BriefPage tabId={tabId} date={briefDate} active={paneActive} />
        ) : noteId !== undefined ? (
          // A note is shell-drawn too, and lazily: the editor's chunk loads
          // the first time one is opened.
          <Suspense fallback={null}>
            <NotesPage tabId={tabId} noteId={noteId} active={paneActive} />
          </Suspense>
        ) : (
          <>
            {surface.kind === "stream" && tab !== null ? surface.renderPane(tab, { active: paneActive }) : null}
            {surface.kind === "stream" && paneActive ? <StreamFindBar /> : null}
            {/* A still is the page as it was; while the chrome is raised over a
                waking pane it stands in for the placeholder as it does for a page.
                A stream pane shows the placeholder itself until its first paint,
                which spans the wake, so a second one here would stack on it. */}
            {still !== null ? (
              <PaneStill src={still} />
            ) : waking && surface.kind !== "stream" ? (
              <WakingPane tabId={tabId} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What a pane shows while its sleeping tab wakes: main has the tab's view
 * but keeps it hidden until the page has painted (ShellSnapshot.wakingTabIds),
 * so the switch lands on the tab's own mark — the favicon and title the
 * sidebar row carries — rather than on a blank card or the tab it left.
 */
function WakingPane({ tabId }: { tabId: string }) {
  const tab = useAppStore((state) => state.snapshot?.tabs.find((candidate) => candidate.id === tabId) ?? null);
  if (tab === null) return null;
  const host = displayHost(tab.url);
  return (
    <div
      data-testid="waking-pane"
      role="status"
      aria-label={`Waking ${tab.title || host || "tab"}`}
      className="grid size-full place-items-center"
    >
      <PanePlaceholder tab={tab}>
        <span className="max-w-72 truncate text-[13px] font-medium text-gray-1000">{tab.title || host}</span>
        {host !== "" && tab.title !== "" ? <span className="text-[11px] text-gray-700">{host}</span> : null}
      </PanePlaceholder>
    </div>
  );
}

function SplitBranch({
  node,
  paneIndex,
  stillByTab,
  wakingTabIds,
  drivenTabId,
}: {
  node: Extract<SplitLayoutNode, { kind: "split" }>;
  paneIndex: ReadonlyMap<string, number>;
  stillByTab: ReadonlyMap<string, string>;
  wakingTabIds: readonly string[];
  drivenTabId: string | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [weights, setWeights] = useState(() => node.children.map(() => 1 / node.children.length));
  const tracks = weights.flatMap((weight, index) => index === weights.length - 1 ? [`${weight}fr`] : [`${weight}fr`, "8px"]).join(" ");
  const previewIndex = node.children.findIndex((child) => child.kind === "pane" && child.tabId === SPLIT_DROP_PREVIEW_ID);
  const previewStartTracks = previewIndex < 0
    ? null
    : node.children.flatMap((_, index) => index === node.children.length - 1
      ? [index === previewIndex ? "0fr" : "1fr"]
      : [index === previewIndex ? "0fr" : "1fr", "8px"]
    ).join(" ");
  const style = (node.axis === "vertical"
    ? { gridTemplateColumns: tracks, gridTemplateRows: "minmax(0, 1fr)" }
    : { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: tracks }) as React.CSSProperties & Record<string, string>;
  if (previewStartTracks !== null) style["--split-preview-start-tracks"] = previewStartTracks;

  return (
    <div
      ref={rootRef}
      data-split-preview-axis={previewIndex < 0 ? undefined : node.axis}
      className="grid min-h-0 min-w-0 flex-1"
      style={style}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.kind === "pane" ? child.tabId : `${node.axis}:${index}`}>
          <SplitLayoutView
            node={child}
            paneIndex={paneIndex}
            stillByTab={stillByTab}
            wakingTabIds={wakingTabIds}
            drivenTabId={drivenTabId}
          />
          {index < node.children.length - 1 ? (
            <SplitDivider
              axis={node.axis}
              index={index}
              rootRef={rootRef}
              weights={weights}
              setWeights={setWeights}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The ring's phase, anchored to the wall clock rather than to the mount: the
 * glow main injects into the page (@pistachio/shell-contracts/agent-glow) reads the same
 * clock, so the comet and its spill inside the pane travel together even
 * though neither can see the other.
 *
 * Taken at the moment the ring goes ON THIS ELEMENT — a pane that mounts
 * already ringed, or one the agent moves into — because that is when its
 * animation starts. A delay computed earlier, when the run began or on some
 * other pane, would land this ring a stale offset behind the page's glow.
 */
function useAgentRingDelay(ringed: boolean): string | undefined {
  return useMemo(() => (ringed ? `${String(agentRingDelayMs(Date.now()))}ms` : undefined), [ringed]);
}

/**
 * The still of a pane's page, shown while main has the chrome raised and the
 * live tab view hidden (store.overlayActive) — the page appears to stay put
 * under whatever is drawn over it.
 */
function PaneStill({ src }: { src: string | null }) {
  if (src === null) return null;
  return <img className="pane-still" src={src} alt="" draggable={false} />;
}

function SplitDivider({
  axis,
  index,
  rootRef,
  weights,
  setWeights,
}: {
  axis: SplitAxis;
  index: number;
  rootRef: React.RefObject<HTMLDivElement | null>;
  weights: number[];
  setWeights(value: React.SetStateAction<number[]>): void;
}) {
  const setPaneResizing = useAppStore((state) => state.setPaneResizing);
  const moveBoundary = (coordinate: number, rect: DOMRect) => {
    const extent = axis === "vertical" ? rect.width : rect.height;
    const start = axis === "vertical" ? rect.left : rect.top;
    const usable = Math.max(1, extent - 8 * (weights.length - 1));
    const prefixBefore = weights.slice(0, index).reduce((sum, weight) => sum + weight, 0);
    const pairWeight = (weights[index] ?? 0) + (weights[index + 1] ?? 0);
    const desired = (coordinate - start - index * 8 - 4) / usable;
    const minWeight = Math.min(pairWeight / 2, Math.max(0.08, 150 / usable));
    const boundary = Math.max(prefixBefore + minWeight, Math.min(prefixBefore + pairWeight - minWeight, desired));
    // The grid re-tracks on commit and the surface's ResizeObserver reports
    // the panes' new boxes in that same frame — no explicit re-report here.
    setWeights((current) => current.map((weight, childIndex) => {
      if (childIndex === index) return boundary - prefixBefore;
      if (childIndex === index + 1) return pairWeight - (boundary - prefixBefore);
      return weight;
    }));
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (root === null || event.button !== 0) return;
    event.preventDefault();
    // The surface itself does not move during the drag — only the columns
    // inside it — so its box is measured once, at the start.
    const rect = root.getBoundingClientRect();
    setPaneResizing(true);
    // Pointer moves crossing the panes would be swallowed by the tab views:
    // the drag layer holds the pointer and relays them (lib/pane-drag.ts).
    // The views stay visible, so both pages reflow as the divider travels.
    startPaneDrag(
      { x: event.clientX, y: event.clientY },
      {
        cursor: axis === "vertical" ? "col-resize" : "row-resize",
        onMove: ({ x, y }) => {
          moveBoundary(axis === "vertical" ? x : y, rect);
        },
        onEnd: () => setPaneResizing(false),
      },
    );
  };
  return (
    <div
      role="separator"
      aria-label="Resize split panes"
      aria-orientation={axis === "vertical" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round((weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0)) * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        setWeights(weights.map(() => 1 / weights.length));
      }}
      className={cn(
        "no-drag relative select-none text-gray-600 outline-none hover:text-gray-1000 focus-visible:text-gray-1000",
        axis === "vertical" ? "cursor-col-resize" : "cursor-row-resize",
      )}
    >
      <GripVertical
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2",
          axis === "horizontal" && "rotate-90",
        )}
        aria-hidden="true"
      />
    </div>
  );
}

function sameSpans(a: readonly PaneSpan[], b: readonly PaneSpan[]): boolean {
  return a.length === b.length && a.every((span, index) => {
    const other = b[index]!;
    return span.tabId === other.tabId && span.left === other.left && span.right === other.right;
  });
}

function rectBounds(rect: DOMRect): ContentBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** Measure an element's layout box relative to `root`, ignoring CSS transforms. */
function layoutBounds(element: HTMLElement, root: HTMLElement, rootRect: DOMRect): ContentBounds {
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = element;
  while (current !== root) {
    x += current.offsetLeft;
    y += current.offsetTop;
    const offsetParent: Element | null = current.offsetParent;
    if (!(offsetParent instanceof HTMLElement))
      return rectBounds(element.getBoundingClientRect());
    current = offsetParent;
  }
  return {
    x: Math.round(rootRect.left + x),
    y: Math.round(rootRect.top + y),
    width: Math.max(1, Math.round(element.offsetWidth)),
    height: Math.max(1, Math.round(element.offsetHeight)),
  };
}
