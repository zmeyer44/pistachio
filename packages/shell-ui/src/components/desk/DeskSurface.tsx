import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { SURFACE_GUTTER } from "@pistachio/shell-contracts/chrome";
import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi } from "../../api";
import { cn } from "../../lib/cn";
import { useDeskStore, type DeskVariants } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import { GlanceOverlay } from "../GlanceOverlay";
import { DeskEngine } from "./desk-engine";
import { DeskRail } from "./DeskRail";
import { DeskWindow, holdsGrab } from "./DeskWindow";

const EMPTY_TABS: readonly BrowserTabInfo[] = [];
const EMPTY_IDS: readonly string[] = [];

/** The group's tabs in the group's order, keeping each tab object's identity (the store shares structure). */
function groupTabs(snapshot: ShellSnapshot | null, group: TabGroupInfo | null): readonly BrowserTabInfo[] {
  if (snapshot === null || group === null) return EMPTY_TABS;
  const byId = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  return group.tabIds.map((tabId) => byId.get(tabId)).filter((tab): tab is BrowserTabInfo => tab !== undefined);
}

/**
 * The desk: a tab group's tabs as free windows over the surface, with the
 * group's inventory down its leading side (docs/desk.md). It takes the
 * browser surface's place while it is up — same box, same gutter — so the
 * page in view becomes a window without moving a pixel, and it gives the
 * box back the same way.
 *
 * The motion is the engine's (desk-engine.ts); this component keeps it fed
 * with what the browser says — the group's tabs, which one is active,
 * which are asleep — and draws what the engine says is on the desk.
 */
export default function DeskSurface({ groupId }: { groupId: string }) {
  const group = useAppStore((state) => state.snapshot?.tabGroups.find((candidate) => candidate.id === groupId) ?? null);
  const tabs = useAppStore(useShallow((state) => groupTabs(state.snapshot, group)));
  const allTabIds = useAppStore(useShallow((state) => state.snapshot?.tabs.map((tab) => tab.id) ?? EMPTY_IDS));
  const activeTabId = useAppStore((state) => state.snapshot?.activeTabId ?? null);
  const wakingTabIds = useAppStore((state) => state.snapshot?.wakingTabIds ?? EMPTY_IDS);
  const overlayActive = useAppStore((state) => state.overlayActive);
  const paneStills = useAppStore((state) => state.paneStills);
  const glance = useAppStore((state) => state.glance);
  const sidebarLayout = useAppStore((state) => state.settings.layout.mode === "sidebar");
  const setContentBounds = useAppStore((state) => state.setContentBounds);
  const variants = useDeskStore((state) => state.variants);
  const leaving = useDeskStore((state) => state.leaving);
  const stageRef = useRef<HTMLDivElement>(null);
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const tabKey = tabIds.join(" ");

  // What the engine asks of the browser, always answered from the latest render.
  const latest = useRef({ tabs, wakingTabIds, variants });
  latest.current = { tabs, wakingTabIds, variants };

  const [engine, setEngine] = useState<DeskEngine | null>(null);
  // The tab in view when the desk opened, not one of the group's: it stays
  // the active one until the browser has selected the tab the desk opened on.
  const opener = useRef<string | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const created = new DeskEngine({
      variants: (): DeskVariants => latest.current.variants,
      hasLivePage: (tabId) => {
        const tab = latest.current.tabs.find((candidate) => candidate.id === tabId);
        return tab !== undefined && tab.lifecycle === "live" && !latest.current.wakingTabIds.includes(tabId) && !isShellPageUrl(tab.url);
      },
      select: (tabId) => {
        const store = useAppStore.getState();
        if (store.snapshot?.activeTabId !== tabId) void store.selectTab(tabId);
      },
      save: (windows) => useDeskStore.getState().save(groupId, { windows }),
      leaveDone: () => useDeskStore.getState().finishLeave(),
    });
    created.attachStage(stage);
    const snapshot = useAppStore.getState().snapshot;
    const ids = latest.current.tabs.map((tab) => tab.id);
    const active = snapshot?.activeTabId ?? null;
    // The tab in view becomes the first window; with none of the group's in
    // view, the one used last.
    const entry =
      active !== null && ids.includes(active)
        ? active
        : ([...latest.current.tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null);
    created.start(useDeskStore.getState().saved[groupId]?.windows ?? [], entry, ids);
    if (entry !== null && entry !== active) {
      opener.current = active;
      useAppStore.getState().selectTab(entry).catch(() => undefined);
    }
    setEngine(created);

    const measure = (): void => {
      created.measure();
      const box = stage.getBoundingClientRect();
      setContentBounds({ x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    window.addEventListener("resize", measure);
    // A press with the grab key on a live page: main took it from the page and hands the move here.
    const offGrab = nativeApi()?.onDeskGrab((grab) => created.grabFromPage(grab));
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      offGrab?.();
      created.destroy();
      setEngine(null);
    };
    // One engine per desk: the group is the component's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = useSyncExternalStore(
    useCallback((listener: () => void) => engine?.subscribe(listener) ?? (() => undefined), [engine]),
    () => engine?.getView() ?? null,
  );

  // The group lost a tab (closed, moved out): its window goes.
  useEffect(() => {
    engine?.syncTabs(tabIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tabKey]);

  // A tab woke, a variant changed, the overlay rose or fell: re-decide what is live.
  useEffect(() => {
    engine?.refresh();
  }, [engine, tabs, wakingTabIds, variants, overlayActive]);

  // The browser's active tab is the desk's business: one of the group's
  // comes to the top (or out of the inventory); any other ends the desk —
  // unless it only became active because a desk window's tab was closed.
  const previous = useRef({ activeTabId, allTabIds });
  useEffect(() => {
    const before = previous.current;
    previous.current = { activeTabId, allTabIds };
    if (engine === null || activeTabId === null || leaving) return;
    if (tabIds.includes(activeTabId)) {
      opener.current = null;
      engine.activeChanged(activeTabId);
      return;
    }
    // Still the tab from before the desk, its own on the way: no reason to leave.
    if (activeTabId === opener.current) return;
    const closedWindow = before.activeTabId !== null && !allTabIds.includes(before.activeTabId) && engine.windowTabIds().length > 0;
    if (closedWindow) {
      const top = engine.windowTabIds().at(-1);
      if (top !== undefined) void useAppStore.getState().selectTab(top);
      return;
    }
    useDeskStore.getState().leave({ immediate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, activeTabId]);

  // The group is gone (ungrouped, closed, another Space): so is its desk.
  useEffect(() => {
    if (group === null) useDeskStore.getState().leave({ immediate: true });
  }, [group]);

  useEffect(() => {
    if (leaving) engine?.leave();
  }, [engine, leaving]);

  // The grab key held over the desk: the frames show an open hand.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || variants.grab === "off") return;
    const arm = (event: KeyboardEvent | PointerEvent): void => {
      if (holdsGrab(event, variants.grab)) stage.dataset["grabArmed"] = "";
      else delete stage.dataset["grabArmed"];
    };
    const disarm = (): void => {
      delete stage.dataset["grabArmed"];
    };
    window.addEventListener("keydown", arm);
    window.addEventListener("keyup", arm);
    stage.addEventListener("pointermove", arm);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("keydown", arm);
      window.removeEventListener("keyup", arm);
      stage.removeEventListener("pointermove", arm);
      window.removeEventListener("blur", disarm);
      disarm();
    };
  }, [variants.grab]);

  const stillByTab = useMemo(() => new Map(paneStills.map((still) => [still.tabId, still.dataUrl])), [paneStills]);
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const attachZone = useCallback((el: HTMLDivElement | null) => engine?.attachZone(el), [engine]);
  const attachGuides = useCallback((el: HTMLDivElement | null) => engine?.attachGuides(el), [engine]);

  return (
    <section
      data-testid="desk-surface"
      className={cn("browser-surface desk-surface relative flex min-h-0 min-w-0 flex-1 bg-background-200 p-2", sidebarLayout && "drag-region")}
      style={{ paddingTop: SURFACE_GUTTER, paddingLeft: sidebarLayout ? 0 : SURFACE_GUTTER }}
    >
      <div
        ref={stageRef}
        data-phase={view?.phase ?? "entering"}
        data-gesture={view?.gesture ?? undefined}
        data-group-color={group?.color}
        className="desk-stage no-drag tab-group-tone relative min-h-0 min-w-0 flex-1"
      >
        <div ref={attachZone} className="desk-zone" aria-hidden="true" />
        <div ref={attachGuides} className="desk-guides" aria-hidden="true">
          <span />
          <span />
        </div>
        {engine === null || view === null
          ? null
          : view.windows.map((window) => (
              <DeskWindow
                key={window.tabId}
                view={window}
                tab={tabsById.get(window.tabId) ?? null}
                chrome={variants.chrome}
                grab={variants.grab}
                // Under a raised overlay the live pages are down: paint what they were showing.
                still={(overlayActive ? stillByTab.get(window.tabId) : undefined) ?? window.still}
                waking={wakingTabIds.includes(window.tabId)}
                engine={engine}
              />
            ))}
        {engine === null || view === null || group === null ? null : <DeskRail group={group} tabs={tabs} view={view} engine={engine} />}
        {glance === null ? null : <GlanceOverlay key={glance.tab.id} glance={glance} surfaceRef={stageRef} />}
      </div>
    </section>
  );
}
