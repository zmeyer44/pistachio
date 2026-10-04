import { ArrowDownToLine, RefreshCw } from "lucide-react";
import { cn } from "../lib/cn";
import { useAppStore } from "../store";
import { ChromePill } from "./ChromePill";

/**
 * The chrome's word that a newer Pistachio exists. Nothing is rendered until
 * a release is available; then one pill carries the next step — download,
 * the download's progress, restart — so applying an update is one click from
 * anywhere, and never something the app does on its own. The full story
 * (version, date, errors, a manual check) is in Settings → About.
 *
 * It lives in the chrome rather than over the page because a surface over
 * the content hole freezes the page under it (App.tsx).
 */
export function UpdatePill() {
  const update = useAppStore((s) => s.update);
  const download = useAppStore((s) => s.downloadUpdate);
  const install = useAppStore((s) => s.installUpdate);

  if (update.status !== "available" && update.status !== "downloading" && update.status !== "ready") return null;

  const busy = update.status === "downloading";
  // The footer's circle unrolls just a word; the title says the rest.
  const label = update.status === "ready" ? "Restart" : update.status === "downloading" ? `${update.percent}%` : "Update";
  const title =
    update.status === "ready"
      ? `Pistachio ${update.version} is downloaded. Restart to finish — tabs and Spaces come back as they are.`
      : update.status === "downloading"
        ? `Downloading Pistachio ${update.version} in the background.`
        : `Pistachio ${update.version} is available. Download it in the background; nothing changes until you restart.`;

  return (
    <ChromePill
      title={title}
      aria-label={title}
      aria-busy={busy || undefined}
      data-testid="update-pill"
      data-status={update.status}
      disabled={busy}
      onClick={() => {
        if (update.status === "ready") install();
        else void download();
      }}
      tone="bg-blue-700 text-white hover:bg-blue-900 disabled:cursor-default disabled:hover:bg-blue-700"
      icon={update.status === "ready" ? <RefreshCw className="size-3.5" /> : <ArrowDownToLine className={cn("size-3.5", busy && "animate-pulse")} />}
      label={label}
    />
  );
}
