import { Monitor } from "lucide-react";
import { useMemo } from "react";
import type { ThreadListItem } from "@pistachio/protocol";
import { planesFor, type PlaneRow } from "../lib/chrome-status";
import { cn } from "../lib/cn";
import { useAppStore } from "../store";
import { useSurface, type SurfaceRendering } from "../surface";

/** Browser trust state as the sidebar's footer menu shows it (components/SidebarMenu.tsx). */
export interface BrowserStatus {
  rendering: SurfaceRendering | null;
  /**
   * The account, cloud and egress planes as rows (lib/chrome-status.ts):
   * each states what is actually true of its plane, and carries the
   * settings page that can change it.
   */
  planes: PlaneRow[];
}

const EMPTY_THREADS: ThreadListItem[] = [];

/** Browser trust state, summarised once for every control that shows it. */
export function useBrowserStatus(): BrowserStatus {
  const account = useAppStore((state) => state.account);
  const sync = useAppStore((state) => state.syncStatus);
  const cloud = useAppStore((state) => state.cloud);
  const egress = useAppStore((state) => state.egress);
  const activeSpaceId = useAppStore((state) => state.snapshot?.activeSpaceId ?? null);
  const threads = useAppStore((state) => state.snapshot?.threads ?? EMPTY_THREADS);
  // The rows name planes, and which planes this shell answers for depends on
  // where it is running: in a browser tab all four subjects are managed from
  // the web app, so they fold into one row that says so and links there.
  const surface = useSurface();
  const activeTabId = useAppStore((state) => state.snapshot?.activeTabId ?? null);
  const rendering = surface.kind === "stream" && surface.rendering?.tabId === activeTabId
    ? surface.rendering : null;
  const accountUrl = surface.kind === "stream" ? surface.accountUrl : undefined;
  return useMemo(
    () => ({
      rendering,
      planes: planesFor({ account, sync, cloud, egress, activeSpaceId, threads, accountUrl }, surface.kind),
    }),
    [account, sync, cloud, egress, activeSpaceId, threads, surface.kind, accountUrl, rendering],
  );
}

/** The active renderer and the reason this page needs compatibility mode. */
export function RenderingStatus({ rendering }: { rendering: BrowserStatus["rendering"] }) {
  if (rendering === null) return null;
  const { mode, reason, retryDom, usePixels, mediaCount } = rendering;
  return (
    <div role="status" data-testid="browser-rendering-status" data-renderer={mode}
      className="flex items-start gap-2 px-2 py-1.5">
      <Monitor aria-hidden="true" className={cn("mt-1 size-3.5 shrink-0", mode === "fallback" ? "text-amber-900" : "text-green-900")} />
      <span className="min-w-0">
        <span className="block text-[10.5px] leading-3.5 text-gray-700">Rendering</span>
        <span className="block text-[12.5px] leading-4 text-gray-1000">
          {mode === "dom" ? mediaCount ? "DOM + media playback" : "DOM mirroring" : mode === "fallback" ? mediaCount ? "Pixel fallback + audio" : "Pixel fallback" : mediaCount ? "Pixel stream + audio" : "Pixel stream"}
        </span>
        {reason ? <span data-testid="browser-rendering-reason" className="mt-1 block text-[11px] text-gray-700">{reason}</span> : null}
        {usePixels ? <button type="button" onClick={usePixels}
          className="mt-1 cursor-pointer text-[11px] text-blue-900 underline underline-offset-2">Use pixel rendering</button> : null}
        {retryDom ? <button type="button" onClick={retryDom}
          className="mt-1 cursor-pointer text-[11px] text-blue-900 underline underline-offset-2">{mode === "fallback" ? "Retry DOM mirroring" : "Use DOM mirroring"}</button> : null}
      </span>
    </div>
  );
}
