import { ArrowDownToLine, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { chromeIconButtonClass, useAction } from "../chrome/actions";
import type { ChromeOrientation } from "../chrome/manifest-renderers";
import { cn } from "../lib/cn";
import { downloadsChipLabel, FRESH_MS, summarizeDownloads } from "../lib/downloads";
import { useAppStore } from "../store";

/**
 * The chrome's word on downloads — the `downloads` feature (chrome/manifest.ts).
 * Nothing until this session downloads something; then a pill with the
 * transfer's progress, a green "Downloaded" for a moment once it lands, and
 * after that the plain 24px icon button, so the list stays one click away
 * without a pill sitting in the chrome all day. Every state opens the
 * list (components/DownloadsPopover.tsx), which hangs from this button.
 *
 * It lives in the chrome rather than over the page because a surface over
 * the content hole freezes the page under it (App.tsx) — the same reason
 * the update pill does.
 */
export function DownloadsChip({ orientation }: { orientation: ChromeOrientation }) {
  const downloads = useAppStore((s) => s.downloads);
  const open = useAppStore((s) => s.overlay === "downloads");
  const { label: actionLabel, hint, run } = useAction("openDownloads");
  // "Downloaded" expires on its own: re-read the clock when the newest
  // finish would age out, and not otherwise.
  const [now, setNow] = useState(() => Date.now());
  const newestFinish = downloads.reduce((newest, d) => (d.finishedAt !== null && d.finishedAt > newest ? d.finishedAt : newest), 0);
  useEffect(() => {
    const at = Date.now();
    setNow(at);
    const wait = newestFinish + FRESH_MS - at;
    if (newestFinish === 0 || wait <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 20);
    return () => window.clearTimeout(timer);
  }, [newestFinish]);

  const summary = summarizeDownloads(downloads, now);
  if (!summary.any) return null;
  const label = downloadsChipLabel(summary);
  const title = hint === null ? actionLabel : `${actionLabel} (${hint})`;

  if (label === null) {
    return (
      <button
        type="button"
        title={title}
        aria-label={actionLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="downloads-chip"
        data-state="idle"
        onClick={run}
        className={chromeIconButtonClass({ enabled: true, pressed: open }, summary.failed > 0 && !open ? "text-amber-900 hover:bg-amber-100" : undefined)}
      >
        <ArrowDownToLine aria-hidden="true" />
      </button>
    );
  }

  const live = summary.live > 0;
  return (
    <button
      type="button"
      title={title}
      aria-label={`${label} — ${actionLabel}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-busy={live || undefined}
      data-testid="downloads-chip"
      data-state={live ? "progress" : "fresh"}
      onClick={run}
      className={cn(
        "no-drag inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-label-12 whitespace-nowrap transition-colors",
        live ? "bg-blue-100 text-blue-900 hover:bg-blue-200" : "bg-green-100 text-green-900 hover:bg-green-200",
        orientation === "vertical" && "min-w-0 flex-1 justify-center",
      )}
    >
      {live ? <ArrowDownToLine className="size-3.5 animate-pulse" aria-hidden="true" /> : <Check className="size-3.5" aria-hidden="true" />}
      <span className="truncate">{label}</span>
    </button>
  );
}
