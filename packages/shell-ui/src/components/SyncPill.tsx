import { useMemo } from "react";
import { Cloud, CloudOff, RefreshCw, ShieldAlert } from "lucide-react";
import type { ThreadListItem } from "@pistachio/protocol";
import type { ChromeOrientation } from "../chrome/manifest-renderers";
import { useShell } from "../chrome/shell-host";
import { syncPillView, type SyncPillView } from "../lib/chrome-status";
import { useSurface } from "../surface";
import { cn } from "../lib/cn";
import { useAppStore } from "../store";
import { ChromePill } from "./ChromePill";

/**
 * The chrome's word about session sync, when there is one
 * (docs/cloud-sync-design.md §10.6).
 *
 * Modelled on UpdatePill, including the part that matters most: nothing is
 * rendered in the ordinary case. Sync that is working is not news, and a
 * permanent "Synced" chip is a light people stop seeing — so the pill exists
 * only while something is stuck (the hub is unreachable, changes are
 * waiting), broken (this device's key was revoked), or happening somewhere
 * else (a run is working in the cloud browser). Each state carries its own
 * next step: the settings page that can fix it, or the live view of the run.
 *
 * It lives in the chrome rather than over the page because a surface over
 * the content hole freezes the page under it (App.tsx).
 */
export function SyncPill({ orientation }: { orientation: ChromeOrientation }) {
  const sync = useAppStore((state) => state.syncStatus);
  const workspace = useAppStore((state) => state.workspaceSync);
  const cloud = useAppStore((state) => state.cloud);
  const threads = useAppStore((state) => state.snapshot?.threads ?? EMPTY_THREADS);
  const { run } = useShell();
  const surface = useSurface().kind;

  const view = useMemo(
    () => syncPillView({ sync, workspace, cloud, threads, surface }),
    [sync, workspace, cloud, threads, surface],
  );
  if (view === null) return null;

  return (
    <ChromePill
      orientation={orientation}
      title={view.title}
      aria-label={`${view.label}. ${view.title}`}
      data-testid="sync-pill"
      data-state={view.state}
      onClick={() => {
        // Through the shell host like every other chrome control, so the
        // pill, a relayed shortcut, and a utility view all take one path.
        if (view.action.kind === "live") run({ type: "openLiveView", runId: view.action.runId });
        else run({ type: "openSettings", section: view.action.section });
      }}
      tone={TONE[view.tone]}
      icon={<PillIcon state={view.state} />}
      label={view.label}
    />
  );
}

const EMPTY_THREADS: ThreadListItem[] = [];

const TONE: Record<SyncPillView["tone"], string> = {
  amber: "bg-amber-100 text-amber-900 hover:bg-amber-200",
  red: "bg-red-100 text-red-900 hover:bg-red-200",
  blue: "bg-blue-100 text-blue-900 hover:bg-blue-200",
};

function PillIcon({ state }: { state: SyncPillView["state"] }) {
  const className = "size-3.5";
  switch (state) {
    case "revoked":
      return <ShieldAlert className={className} aria-hidden="true" />;
    case "paused":
      return <CloudOff className={className} aria-hidden="true" />;
    case "queued":
      return <RefreshCw className={className} aria-hidden="true" />;
    default:
      return <Cloud className={cn(className, "animate-pulse")} aria-hidden="true" />;
  }
}
