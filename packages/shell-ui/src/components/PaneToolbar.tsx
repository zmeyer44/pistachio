import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { BookmarkCheck, BookmarkPlus, BookOpen, BookOpenText, ChevronLeft, ChevronRight, Pin, PinOff, RotateCw, X } from "lucide-react";
import { bookmarkUrlKey, isBookmarkableUrl } from "@pistachio/shell-contracts/bookmarks";
import { canReadUrl, isReaderUrl } from "@pistachio/shell-contracts/reader";
import {
  PANE_TOOLBAR_H,
  PANE_TOOLBAR_TRIGGER_H,
  pointerHoldsPaneToolbar,
  SURFACE_GUTTER,
} from "@pistachio/shell-contracts/chrome";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { chromeIconButtonClass } from "../chrome/actions";
import { useShell } from "../chrome/shell-host";
import { tabLabel } from "../chrome/tab-parts";
import { useChromeTabs, type ChromeTab } from "../chrome/tabs";
import { toolbarClusters, type PaneSpan } from "../lib/pane-toolbar";
import { useAppStore } from "../store";
import { TabMark } from "./Favicon";
import { SiteInfoButton } from "./SiteInfoPopover";
import { SplitExit } from "./split-icons";
import { nativeApi } from "../api";

/**
 * The pane toolbar: a row of per-pane controls that the page card slides
 * down to make room for, in the sidebar layout, when the pointer moves in
 * the gap between the card and the window's top edge (@pistachio/shell-contracts/chrome,
 * "pane toolbar"). The row is the sidebar toolbar's row — TRAFFIC_LIGHTS_H
 * tall, its buttons on the traffic lights' centre line — so close, pin and
 * bookmark read as one line with back, forward and reload. One cluster per
 * visible pane, over that pane (lib/pane-toolbar.ts): a split view gets a
 * close button for each of its tabs.
 *
 * The slide is BrowserSurface's top padding transitioning from the gutter
 * to the row's height (styles.css, ".pane-toolbar"), which the surface's
 * ResizeObserver reports to main frame by frame, so the native page views
 * reflow under the row exactly as they do beside the compact sidebar; the
 * row itself translates in over the same frames and stays mounted across
 * the cycle, so an interrupted hide reverses instead of restarting.
 *
 * WHO DECIDES THE POINTER IS THERE, AND WHEN IT HAS LEFT: the OS pointer,
 * read by main (PistachioApi.setPaneToolbarTrigger / setPaneToolbarWatch),
 * as for the compact sidebar. The gap is a window drag region whose native
 * handling keeps pointer moves from the page, and the tab views below the
 * row take the pointer without a word — the page's own events cannot tell
 * a pointer on the row's empty drag area from one that went to the page.
 * The trigger strip's own pointer move and the row's leave stand only
 * where main cannot read the pointer (Playwright, where getCursorPoint
 * answers null).
 */
export function PaneToolbar({
  surfaceRef,
  paneTabIds,
  spans,
}: {
  surfaceRef: RefObject<HTMLElement | null>;
  /** The visible panes, in pane order. */
  paneTabIds: readonly string[];
  /** Each visible pane's horizontal extent, viewport px. */
  spans: readonly PaneSpan[];
}) {
  const revealed = useAppStore((state) => state.paneToolbarRevealed);
  const setRevealed = useAppStore((state) => state.setPaneToolbarRevealed);
  const sidebarLayout = useAppStore((state) => state.settings.layout.mode === "sidebar");
  // The site-info popover is the row's own: it opens from a button on the
  // row, so it neither disarms the row nor counts as the pointer leaving it.
  const overlayUp = useAppStore(
    (state) => (state.overlay !== "none" && state.overlay !== "site-info") || state.error !== null || state.onboardingOpen,
  );
  const glancing = useAppStore((state) => state.glance !== null);
  // Busy: a gesture, or the popover, is holding the row out whatever the pointer does.
  const busy = useAppStore((state) => state.paneResizing || state.tabDragging || state.overlay === "site-info");
  // The row can come out only over a bare page: not under a shell page or
  // modal, not during a Glance, and not while a drag is reshaping the panes.
  const armed = sidebarLayout && !overlayUp && !glancing && !busy;

  const holdBox = useRef<ContentBounds | null>(null);
  const check = useRef<number | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;

  const hide = () => {
    if (busyRef.current) return;
    setRevealed(false);
  };
  const cancelCheck = () => {
    if (check.current === null) return;
    window.clearTimeout(check.current);
    check.current = null;
  };
  /** A leave the page saw: worth a look, not yet a fact. */
  const scheduleCheck = () => {
    if (!revealedRef.current) return;
    cancelCheck();
    check.current = window.setTimeout(() => {
      check.current = null;
      void (async () => {
        const point = (await nativeApi()?.getCursorPoint()) ?? null;
        const box = holdBox.current;
        if (point === null || box === null || !pointerHoldsPaneToolbar(point, box)) hide();
      })();
    }, LEAVE_CHECK_MS);
  };

  // Disarmed while up: leave now, whatever the pointer is doing.
  useEffect(() => {
    if (!armed && revealed && !busy) setRevealed(false);
  }, [armed, revealed, busy, setRevealed]);

  // Main's watch on the gap above the card (hidden) or on the row (revealed).
  // The surface's box moves with the sidebar and the console, so both are
  // re-reported as it resizes. A passive effect, not a layout one: this is
  // the surface's child, and a parent's ref is attached only after its
  // children's layout effects have run — at mount the surface would read
  // as null here and the watch would never be armed.
  useEffect(() => {
    if (!armed) return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    let frame = 0;
    const report = () => {
      frame = 0;
      const rect = surface.getBoundingClientRect();
      if (revealed) {
        holdBox.current = { x: rect.x, y: rect.y, width: rect.width, height: PANE_TOOLBAR_H };
        nativeApi()?.setPaneToolbarWatch(holdBox.current);
      } else {
        nativeApi()?.setPaneToolbarTrigger({ x: rect.x, y: rect.y, width: rect.width, height: PANE_TOOLBAR_TRIGGER_H });
      }
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(report);
    };
    report();
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    observer.observe(document.documentElement);
    return () => {
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
      if (revealed) {
        holdBox.current = null;
        nativeApi()?.setPaneToolbarWatch(null);
      } else {
        nativeApi()?.setPaneToolbarTrigger(null);
      }
    };
  }, [armed, revealed, surfaceRef]);

  // Main's verdicts, and the page's hints.
  useEffect(() => {
    const offEntered = nativeApi()?.onPaneToolbarPointerEntered(() => {
      const state = useAppStore.getState();
      if (state.settings.layout.mode === "sidebar") state.setPaneToolbarRevealed(true);
    });
    const offLeft = nativeApi()?.onPaneToolbarPointerLeft(() => {
      cancelCheck();
      hide();
    });
    const onMouseLeave = () => scheduleCheck();
    const onBlur = () => scheduleCheck();
    document.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("blur", onBlur);
    return () => {
      offEntered?.();
      offLeft?.();
      document.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("blur", onBlur);
      cancelCheck();
    };
    // Handlers close over refs and stable setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A gesture (or the popover) that held the row has ended: where the pointer
  // is now is the answer, and main's watch may have already given up its verdict.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && revealed) {
      if (holdBox.current !== null) nativeApi()?.setPaneToolbarWatch(holdBox.current);
      scheduleCheck();
    }
    wasBusy.current = busy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, revealed]);

  // Back / forward / reload over each pane when the sidebar's own row is not
  // there to do it (compact) or cannot say which pane it means (a split).
  const sidebarCompact = useAppStore((state) => state.settings.layout.sidebar !== "pinned");
  const showNav = sidebarCompact || paneTabIds.length > 1;

  const tabs = useChromeTabs();
  const clusters = useMemo(() => {
    const surface = surfaceRef.current;
    const originX = surface?.getBoundingClientRect().x ?? 0;
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    const ordered = paneTabIds.flatMap((tabId) => {
      const span = spans.find((candidate) => candidate.tabId === tabId);
      return span === undefined ? [] : [{ tabId, left: span.left - originX, right: span.right - originX }];
    });
    return toolbarClusters(ordered).flatMap((cluster) => {
      const tab = byId.get(cluster.tabId);
      return tab === undefined ? [] : [{ ...cluster, tab }];
    });
  }, [tabs, paneTabIds, spans, surfaceRef]);

  if (!sidebarLayout) return null;
  return (
    <>
      {/* The reveal target, under the row. Stays a drag region: a pointer
          move here reaches the page only where the OS's drag handling does
          not take it first (Playwright), and main's watch covers the rest. */}
      {revealed ? null : (
        <div
          data-testid="pane-toolbar-trigger"
          aria-hidden="true"
          className="absolute inset-x-0 top-0"
          style={{ height: PANE_TOOLBAR_TRIGGER_H }}
          onPointerMove={() => {
            if (armed) setRevealed(true);
          }}
        />
      )}
      <div
        role="toolbar"
        aria-label="Page controls"
        data-testid="pane-toolbar"
        data-hidden={!revealed ? "" : undefined}
        aria-hidden={!revealed || undefined}
        inert={!revealed || undefined}
        className="pane-toolbar absolute inset-x-0 top-0 z-10"
        style={{ height: PANE_TOOLBAR_H }}
        onPointerEnter={cancelCheck}
        onPointerLeave={scheduleCheck}
      >
        {clusters.map((cluster) => (
          <PaneCluster key={cluster.tab.id} tab={cluster.tab} left={cluster.left} width={cluster.width} showNav={showNav} />
        ))}
      </div>
    </>
  );
}

/**
 * How long the row waits after a leave before it checks whether the pointer
 * has really gone — the compact sidebar's own delay (layouts/SidebarLayout.tsx).
 */
const LEAVE_CHECK_MS = 120;

/** The narrowest a pane's title button gets while its pane has the room, px (inside its padding). */
const PANE_TITLE_MIN_W = 160;

/**
 * One pane's controls, over that pane: back, forward and reload (when the
 * sidebar is compact or the view is split — `showNav`), its mark and title
 * (a button into the address modal, like the sidebar's address row), then site info (the
 * active pane only — the controls describe the active tab), bookmark, pin,
 * and close pushed to the pane's far edge — the close button's place in
 * every tab row. The cluster is inset by the gutter on both sides so its
 * ends line up with the card's.
 */
function PaneCluster({ tab, left, width, showNav }: { tab: ChromeTab; left: number; width: number; showNav: boolean }) {
  const { run } = useShell();
  const label = tabLabel(tab);
  return (
    <div
      data-testid="pane-toolbar-cluster"
      data-tab-id={tab.id}
      className="absolute top-0 flex h-full items-center gap-1"
      style={{ left: left + SURFACE_GUTTER, width: Math.max(0, width - 2 * SURFACE_GUTTER) }}
    >
      {showNav ? <PaneNavButtons tab={tab} /> : null}
      {/* As wide as its title, never narrower than the strut below while the
          pane has the room, and shrinking (title truncating) once it has not.
          A plain min-width would not shrink and would push close off a narrow
          pane; the zero-height strut only raises the button's preferred width. */}
      <button
        type="button"
        title="Edit address"
        aria-label={`Edit address of ${label}`}
        data-testid="pane-toolbar-title"
        onClick={() => run({ type: "openUrlBar", tabId: tab.id })}
        className="no-drag grid h-6 min-w-0 shrink cursor-pointer grid-cols-[minmax(0,1fr)] content-center overflow-hidden rounded-sm px-1.5 text-left transition-colors hover:bg-alpha-200"
      >
        <span className="flex min-w-0 items-center gap-2">
          <TabMark tab={tab} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-gray-900">{label}</span>
        </span>
        <span aria-hidden="true" className="h-0" style={{ width: PANE_TITLE_MIN_W }} />
      </button>
      {/* The room the title does not need: window drag area, like the rest of
          the row outside its buttons. */}
      <div aria-hidden="true" className="h-full min-w-0 flex-1" />
      <ReaderButton tab={tab} />
      {tab.active ? <SiteInfoButton variant="pane" /> : null}
      <BookmarkButton tab={tab} />
      <PinButton tab={tab} />
      <RemoveFromSplitButton tab={tab} />
      <CloseButton tab={tab} />
    </div>
  );
}

/**
 * The sidebar toolbar's back / forward / reload (chrome/manifest-renderers.tsx
 * NavigationCluster), bound to this pane's tab rather than the active one.
 * Like the sidebar's, a direction with no history stays in place, dimmed.
 */
function PaneNavButtons({ tab }: { tab: ChromeTab }) {
  const goBack = useAppStore((state) => state.goBack);
  const goForward = useAppStore((state) => state.goForward);
  const reload = useAppStore((state) => state.reload);
  const label = tabLabel(tab);
  return (
    <>
      <PaneNavButton
        label="Back"
        ariaLabel={`Go back in ${label}`}
        testId="pane-toolbar-back"
        enabled={tab.canGoBack}
        onClick={() => void goBack(tab.id)}
      >
        <ChevronLeft aria-hidden="true" />
      </PaneNavButton>
      <PaneNavButton
        label="Forward"
        ariaLabel={`Go forward in ${label}`}
        testId="pane-toolbar-forward"
        enabled={tab.canGoForward}
        onClick={() => void goForward(tab.id)}
      >
        <ChevronRight aria-hidden="true" />
      </PaneNavButton>
      <PaneNavButton
        label="Reload"
        ariaLabel={`Reload ${label}`}
        testId="pane-toolbar-reload"
        enabled
        onClick={() => void reload(tab.id)}
      >
        <RotateCw aria-hidden="true" />
      </PaneNavButton>
    </>
  );
}

function PaneNavButton({
  label,
  ariaLabel,
  testId,
  enabled,
  onClick,
  children,
}: {
  label: string;
  ariaLabel: string;
  testId: string;
  enabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={ariaLabel}
      aria-disabled={enabled ? undefined : true}
      data-testid={testId}
      onClick={() => {
        if (enabled) onClick();
      }}
      className={chromeIconButtonClass({ enabled, pressed: false })}
    >
      {children}
    </button>
  );
}

/**
 * Shows the page's article stripped to its prose, or returns to the page.
 * Offered on any web page: whether a page HAS an article is only knowable by
 * reading it, so the answer arrives as a toast rather than a greyed button.
 */
function ReaderButton({ tab }: { tab: ChromeTab }) {
  const toggleReaderView = useAppStore((state) => state.toggleReaderView);
  if (tab.kind !== "human" || !canReadUrl(tab.url)) return null;
  const reading = isReaderUrl(tab.url);
  return (
    <button
      type="button"
      data-testid={`reader-toggle-${tab.id}`}
      title={reading ? "Hide reader" : "Reader view"}
      aria-label={reading ? `Leave reader view for ${tabLabel(tab)}` : `Read ${tabLabel(tab)} in reader view`}
      aria-pressed={reading}
      onClick={() => void toggleReaderView(tab.id)}
      className={chromeIconButtonClass({ enabled: true, pressed: reading })}
    >
      {reading ? <BookOpenText aria-hidden="true" /> : <BookOpen aria-hidden="true" />}
    </button>
  );
}

/** Keeps the page as a bookmark, or lets a kept one go. */
function BookmarkButton({ tab }: { tab: ChromeTab }) {
  const { run } = useShell();
  const deleteBookmark = useAppStore((state) => state.deleteBookmark);
  const key = bookmarkUrlKey(tab.url);
  const bookmark = useAppStore((state) => state.bookmarks.bookmarks.find((candidate) => bookmarkUrlKey(candidate.url) === key) ?? null);
  // A web page of the person's own: the app's pages are chrome, not things.
  const enabled = tab.kind === "human" && isBookmarkableUrl(tab.url);
  if (!enabled) return null;
  const kept = bookmark !== null;
  return (
    <button
      type="button"
      title={kept ? "Remove bookmark" : "Bookmark this page"}
      aria-label={kept ? `Remove bookmark for ${tabLabel(tab)}` : `Bookmark ${tabLabel(tab)}`}
      aria-pressed={kept}
      onClick={() => {
        if (kept) void deleteBookmark(bookmark.id);
        else run({ type: "bookmarkPage", tabId: tab.id });
      }}
      className={chromeIconButtonClass({ enabled: true, pressed: kept })}
    >
      {kept ? <BookmarkCheck aria-hidden="true" /> : <BookmarkPlus aria-hidden="true" />}
    </button>
  );
}

/**
 * Keeps this tab as a pin on the sidebar shelf, or lets a pinned one go —
 * the tab row's own rule (chrome/tab-parts.tsx PinToggleButton): a person's
 * page only, and never a favorite's tab, which is the grid's to keep.
 */
function PinButton({ tab }: { tab: ChromeTab }) {
  const sidebarCommand = useAppStore((state) => state.sidebarCommand);
  const pinned = useAppStore(
    (state) => tab.anchorId !== null && (state.snapshot?.sidebar.entries.some((entry) => entry.kind === "pin" && entry.id === tab.anchorId) ?? false),
  );
  if (tab.kind !== "human" || (tab.anchorId !== null && !pinned)) return null;
  return (
    <button
      type="button"
      title={pinned ? "Unpin tab" : "Pin tab"}
      aria-label={pinned ? `Unpin ${tabLabel(tab)}` : `Pin ${tabLabel(tab)}`}
      aria-pressed={pinned}
      onClick={() => {
        if (pinned) void sidebarCommand({ type: "unpin", pinId: tab.anchorId ?? "" });
        else void sidebarCommand({ type: "pinTab", tabId: tab.id, folderId: null, index: 10_000 });
      }}
      className={chromeIconButtonClass({ enabled: true, pressed: pinned })}
    >
      {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
    </button>
  );
}

/**
 * Takes this pane out of the split view without closing its tab: the page
 * stays open as a background tab while the remaining pane(s) keep the
 * surface. Only a pane that is actually in a split group offers it.
 */
function RemoveFromSplitButton({ tab }: { tab: ChromeTab }) {
  const removeFromSplit = useAppStore((state) => state.removeFromSplit);
  if (tab.splitGroup === null) return null;
  return (
    <button
      type="button"
      title="Remove from split view"
      aria-label={`Remove ${tabLabel(tab)} from split view`}
      data-testid="pane-toolbar-unsplit"
      onClick={() => void removeFromSplit(tab.id)}
      className={chromeIconButtonClass({ enabled: true, pressed: false })}
    >
      <SplitExit aria-hidden="true" />
    </button>
  );
}

function CloseButton({ tab }: { tab: ChromeTab }) {
  const closeTab = useAppStore((state) => state.closeTab);
  return (
    <button
      type="button"
      title="Close tab"
      aria-label={`Close ${tabLabel(tab)}`}
      data-testid="pane-toolbar-close"
      onClick={() => void closeTab(tab.id)}
      className={chromeIconButtonClass({ enabled: true, pressed: false })}
    >
      <X aria-hidden="true" />
    </button>
  );
}
