import { ScreenShare } from "lucide-react";
import { useEffect, useRef } from "react";
import { screenShareObject, type ScreenShareInfo } from "@pistachio/shell-contracts/screen-share";
import type { ChromeOrientation } from "../chrome/manifest-renderers";
import { displayHost } from "../lib/url";
import { useAppStore } from "../store";

/**
 * Saying that the screen is being shared, for exactly as long as it is
 * (@pistachio/shell-contracts/screen-share): a red pill in the strip, a red
 * card at the foot of the sidebar, each with the tab it comes from and a
 * way to stop it. The sharing tab carries its own mark (TabScreenShareMark),
 * and the hidden compact sidebar keeps a red handle at the window's edge
 * (SidebarEdge), so no layout is without a sign of it.
 */

/** A stable empty list: a selector returning a fresh `[]` would re-render on every publish. */
const NO_SHARES: readonly ScreenShareInfo[] = [];

/** Every tab sharing the screen, in every Space, oldest share first. */
export function useScreenShares(): readonly ScreenShareInfo[] {
  return useAppStore((state) => state.snapshot?.screenShares ?? NO_SHARES);
}

/** The sidebar card's height, and the gap under it (`.sidebar-media-dock`). */
const CARD_H = 50;
const CARD_GAP = 6;

/** How much of the tab list's bottom the sidebar's cards cover, beside the media stack's (useMediaStackInset). */
export function useScreenShareInset(): number {
  return useScreenShares().length * (CARD_H + CARD_GAP);
}

/** "Sharing your screen", "Sharing a window", "Sharing a tab". */
export function screenShareLabel(share: Pick<ScreenShareInfo, "surface">): string {
  return `Sharing ${screenShareObject(share.surface)}`;
}

function shareHost(share: ScreenShareInfo): string {
  return displayHost(share.tabUrl) || share.tabTitle || "this tab";
}

export function ScreenShareIndicator({ orientation }: { orientation: ChromeOrientation }) {
  const shares = useScreenShares();
  return (
    <>
      {shares.map((share) =>
        orientation === "horizontal" ? (
          <ScreenSharePill key={share.tabId} share={share} />
        ) : (
          <ScreenShareCard key={share.tabId} share={share} />
        ),
      )}
    </>
  );
}

function useShareActions(share: ScreenShareInfo): { show: () => void; stop: () => void } {
  const selectTab = useAppStore((state) => state.selectTab);
  const stopScreenShare = useAppStore((state) => state.stopScreenShare);
  return {
    show: () => void selectTab(share.tabId),
    stop: () => void stopScreenShare(share.tabId),
  };
}

/** The strip's pill: the live dot and what is shared (which goes to the tab), then Stop. */
function ScreenSharePill({ share }: { share: ScreenShareInfo }) {
  const { show, stop } = useShareActions(share);
  const label = screenShareLabel(share);
  const host = shareHost(share);
  return (
    <div
      role="group"
      aria-label={`${label} with ${host}`}
      data-testid="screen-share-pill"
      data-tab-id={share.tabId}
      className="no-drag flex h-7 shrink-0 items-center gap-0.5 rounded-full bg-red-100 pr-0.5 text-red-900 shadow-[inset_0_0_0_1px_var(--color-red-400)]"
    >
      <button
        type="button"
        title={`${label} with ${host}. Go to the tab`}
        onClick={show}
        className="flex h-full cursor-pointer items-center gap-2 rounded-l-full pr-1.5 pl-2.5 text-label-12 whitespace-nowrap transition-colors hover:text-red-1000"
      >
        <span aria-hidden="true" className="screen-share-live" />
        {label}
      </button>
      <button
        type="button"
        data-testid="screen-share-stop"
        aria-label={`Stop sharing ${screenShareObject(share.surface)} with ${host}`}
        onClick={stop}
        className="screen-share-stop"
      >
        Stop
      </button>
    </div>
  );
}

/** The sidebar's card, at the foot of the dock below the media stack: what is shared and with whom, then Stop. */
function ScreenShareCard({ share }: { share: ScreenShareInfo }) {
  const { show, stop } = useShareActions(share);
  const label = screenShareLabel(share);
  const host = shareHost(share);
  return (
    <div
      role="group"
      aria-label={`${label} with ${host}`}
      data-testid="screen-share-card"
      data-tab-id={share.tabId}
      className="screen-share-card no-drag"
    >
      <button type="button" title="Go to the tab" onClick={show} className="screen-share-card-main">
        <span aria-hidden="true" className="screen-share-card-icon">
          <ScreenShare />
          <span className="screen-share-live" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold text-gray-1000">{label}</span>
          <span className="block truncate text-[10.5px] text-gray-700">with {host}</span>
        </span>
      </button>
      <button
        type="button"
        data-testid="screen-share-stop"
        aria-label={`Stop sharing ${screenShareObject(share.surface)} with ${host}`}
        onClick={stop}
        className="screen-share-stop"
      >
        Stop
      </button>
    </div>
  );
}

/**
 * Where the chrome is out of sight — the compact sidebar, hidden — a share
 * that begins says so once as a notice, which shows whatever the layout
 * (NoticeHost). A share already running when this mounts was on screen
 * before the sidebar left, so it is not news.
 */
export function useScreenShareStartNotice(shares: readonly ScreenShareInfo[]): void {
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = new Set(shares.map((share) => `${share.tabId}:${share.startedAt}`));
    const previous = known.current;
    known.current = keys;
    if (previous === null) return;
    const { showNotice, stopScreenShare } = useAppStore.getState();
    for (const share of shares) {
      if (previous.has(`${share.tabId}:${share.startedAt}`)) continue;
      showNotice(`${screenShareLabel(share)} with ${shareHost(share)}`, {
        action: { label: "Stop sharing", run: () => void stopScreenShare(share.tabId) },
      });
    }
  }, [shares]);
}
