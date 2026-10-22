import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PaneStill } from "@pistachio/shell-contracts/ipc";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi } from "../../api";
import { cn } from "../../lib/cn";
import { useDeskCover, type DeskAnchor } from "../../lib/desk/chrome";
import { useDeskEngine } from "../../lib/desk/open";
import { passedEntry, useDeskStore } from "../../lib/desk/store";
import { isTabWindow } from "../../lib/desk/windows";
import { useAppStore } from "../../store";
import type { DeskSketch } from "../desk/desk-engine";
import { Favicon } from "../Favicon";

/** How long the pointer rests on a space's tile before its card comes up (SpaceRail). */
export const RAIL_CARD_DELAY_MS = 1200;
/** The card's width; its desk is drawn this wide less its padding, in the desk's own shape. */
const CARD_W = 236;
const PAD = 8;
/** Its name and window count under the desk. */
const CAPTION_H = 32;
/** How wide main draws a page for the card (device px): the drawn window is a fraction of that. */
const STILL_WIDTH = 480;
/** A page asleep is woken for its picture once in this long; the picture it gave is drawn until then. */
const RETAKE_ASLEEP_MS = 10 * 60_000;

/** At most this many pictures are kept, the oldest let go first. */
const TAKEN_MAX = 48;

/**
 * The pictures the card took, by tab, kept for the next look at a space (a
 * page asleep is not woken for each) — each of the page at `url`: a tab gone
 * elsewhere since is pictured afresh.
 */
const taken = new Map<string, { src: string; at: number; url: string }>();

/** The tabs' addresses now, by tab. */
function tabUrls(): ReadonlyMap<string, string> | null {
  const tabs = useAppStore.getState().snapshot?.tabs;
  return tabs === undefined ? null : new Map(tabs.map((tab) => [tab.id, tab.url]));
}

/** The pictures of tabs closed or gone elsewhere since are let go, and the oldest past TAKEN_MAX. */
function forgetTaken(): void {
  const urls = tabUrls();
  if (urls !== null) for (const [tabId, kept] of [...taken]) if (urls.get(tabId) !== kept.url) taken.delete(tabId);
  for (const [tabId] of [...taken].sort((a, b) => a[1].at - b[1].at).slice(0, Math.max(0, taken.size - TAKEN_MAX))) taken.delete(tabId);
}

/**
 * A space's tile's card on the rail, beside the tile the pointer rests on:
 * the space's desk drawn small — the desk in use as it stands, another
 * space's as it would come out were the desk to pass to it now
 * (DeskEngine.sketchSpace) — each window with a picture of its page (the
 * latest the desk has, then a fresh one main draws for the card: a page
 * asleep woken for it and put back to sleep, previewTabStill, the window in
 * use first; its icon until then), the window in use ringed in the space's
 * colour; under it the space's name and how many windows it has. It lies
 * over the desk past the card column (all of it, the rail alone), so it is a
 * cover: shown once the live pages under it have given way.
 */
export function RailSpaceCard({ group, name, windows, anchor }: { group: TabGroupInfo; name: string; windows: string; anchor: DeskAnchor }) {
  const engine = useDeskEngine();
  const tabs = useAppStore((state) => state.snapshot?.tabs);
  const tabsById = useMemo(() => new Map((tabs ?? []).map((tab) => [tab.id, tab])), [tabs]);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useDeskCover("rail-space-card", ref, true);
  // Drawn once, as the card comes up: what the space looks like now.
  const [sketch] = useState<DeskSketch | null>(() => {
    if (engine === null) return null;
    const saved = useDeskStore.getState().saved[group.id];
    const members = (tabs ?? []).filter((tab) => group.tabIds.includes(tab.id));
    const windows = saved?.windows ?? [];
    return engine.sketchSpace({ groupId: group.id, tabIds: group.tabIds, saved: windows, reserve: saved?.reserve ?? 0, entry: passedEntry(windows, members) });
  });
  const [fresh, setFresh] = useState<ReadonlyMap<string, string>>(() => {
    forgetTaken();
    return new Map((sketch?.windows ?? []).flatMap((win) => (taken.has(win.tabId) ? [[win.tabId, taken.get(win.tabId)!.src] as const] : [])));
  });
  useEffect(() => {
    const api = nativeApi();
    const pages = sketch?.windows.filter((win) => isTabWindow(win.tabId)) ?? [];
    if (api === null || pages.length === 0) return;
    let live = true;
    const device = Math.round(STILL_WIDTH * Math.min(2, window.devicePixelRatio || 1));
    const keep = (stills: readonly PaneStill[]): void => {
      const at = Date.now();
      const urls = tabUrls();
      for (const still of stills) {
        const url = urls?.get(still.tabId);
        if (url !== undefined) taken.set(still.tabId, { src: still.dataUrl, at, url });
      }
      forgetTaken();
      if (live && stills.length > 0) setFresh((shown) => new Map([...shown, ...stills.map((still) => [still.tabId, still.dataUrl] as const)]));
    };
    const lifecycle = new Map((useAppStore.getState().snapshot?.tabs ?? []).map((tab) => [tab.id, tab.lifecycle]));
    const asleep = pages.filter((win) => lifecycle.get(win.tabId) === "suspended").sort((a, b) => Number(b.focused) - Number(a.focused));
    void (async () => {
      // Pages awake: as they stand.
      keep(await api.captureTabStills(pages.filter((win) => !asleep.includes(win)).map((win) => win.tabId), device).catch(() => []));
      // Pages asleep: each woken for its picture and put back to sleep, one at a time, while the card is up — unless it
      // gave one lately.
      for (const win of asleep) {
        if (!live) return;
        const kept = taken.get(win.tabId);
        if (kept !== undefined && Date.now() - kept.at < RETAKE_ASLEEP_MS) continue;
        const still = await api.previewTabStill(win.tabId, { width: win.rect.w, height: win.rect.h }, device).catch(() => null);
        if (still !== null && still !== undefined) keep([still]);
      }
    })();
    return () => {
      live = false;
    };
  }, [sketch]);

  const scale = sketch === null || sketch.width <= 0 ? 0 : (CARD_W - PAD * 2) / sketch.width;
  const deskH = sketch === null ? 0 : Math.round(sketch.height * scale);
  const height = (sketch === null ? PAD : deskH + PAD) + CAPTION_H;
  const top = Math.max(8, Math.min(anchor.y + anchor.h / 2 - height / 2, window.innerHeight - height - 8));
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-testid="rail-space-card"
      data-group-id={group.id}
      data-group-color={group.color}
      data-shown={shown ? "" : undefined}
      className="rail-space-card tab-group-tone shadow-menu"
      style={{ left: anchor.x + anchor.w + 10, top, width: CARD_W }}
    >
      {sketch === null ? null : (
        <div className="rail-space-card-desk" style={{ height: deskH }}>
          {sketch.windows.map((win) => {
            const tab = tabsById.get(win.tabId);
            const src = fresh.get(win.tabId) ?? win.still;
            return (
              <div
                key={win.tabId}
                data-testid="rail-space-card-window"
                data-tab-id={win.tabId}
                data-focused={win.focused ? "" : undefined}
                className={cn("rail-space-card-window", src === null && "rail-space-card-window-blank")}
                style={{ left: win.rect.x * scale, top: win.rect.y * scale, width: win.rect.w * scale, height: win.rect.h * scale }}
              >
                {src === null ? (
                  <Favicon src={tab?.faviconUrl ?? null} seed={tab?.title ?? ""} className="size-3.5" />
                ) : (
                  <img className="rail-space-card-still" src={src} alt="" draggable={false} />
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="rail-space-card-caption">
        <span className="rail-space-card-name">{name}</span>
        <span className="rail-space-card-count">{windows}</span>
      </div>
    </div>,
    document.body,
  );
}
