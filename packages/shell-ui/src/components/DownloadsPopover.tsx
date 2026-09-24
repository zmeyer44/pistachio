import { ArrowDownToLine, Check, FolderOpen, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserDownload } from "@pistachio/shell-contracts/browser-controls";
import { cn } from "../lib/cn";
import { downloadStatusLine } from "../lib/downloads";
import { displayHost } from "../lib/url";
import { useAppStore } from "../store";
import { Button } from "./ui/button";

/**
 * This session's downloads from every tab, newest first: what the chip
 * (components/DownloadsChip.tsx), ⌘⇧J, the Page menu and the sidebar menu
 * open. A row shows the file, where it came from, its progress or how it
 * ended, and the things to do about it — open, show in Finder, cancel,
 * retry, remove — with one Clear for everything settled. The per-site view
 * of the same records stays in Site controls → Transfers.
 *
 * It is a shell overlay (`overlay: "downloads"`) like the site-info popover:
 * main paints stills of the pages and hides the native views while it is
 * up, so a card can hang below the strip over the page at all. It is
 * portalled to the body and positioned fixed from the chip's box; from the
 * sidebar footer, at the window's bottom, it opens upward instead. Opened
 * by key before anything was downloaded there is no chip: it sits at the
 * window's top-right corner then.
 */

const POPOVER_W = 340;
const POPOVER_MAX_H = 380;
const EDGE = 8;
const GAP = 6;

export function DownloadsPopover() {
  const downloads = useAppStore((state) => state.downloads);
  const ready = useAppStore((state) => state.overlayReady);
  const close = useAppStore((state) => state.closeDownloads);
  const run = useAppStore((state) => state.browserControl);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left: number } | null>(null);

  const place = useCallback(() => {
    const chip = document.querySelector<HTMLElement>('[data-testid="downloads-chip"]');
    const rect = chip?.getBoundingClientRect();
    if (rect === undefined) {
      setPosition({ top: EDGE + 40, left: window.innerWidth - POPOVER_W - EDGE });
      return;
    }
    const below = window.innerHeight - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    const left = Math.max(EDGE, Math.min(rect.left - 4, window.innerWidth - POPOVER_W - EDGE));
    if (below >= Math.min(POPOVER_MAX_H, 200) || below >= above) setPosition({ top: rect.bottom + GAP, left });
    else setPosition({ bottom: window.innerHeight - rect.top + GAP, left });
  }, []);
  useLayoutEffect(() => {
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panelRef.current?.contains(event.target) === true) return;
      const chip = document.querySelector('[data-testid="downloads-chip"]');
      if (chip?.contains(event.target) === true) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onBlur = () => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [close]);

  const settled = downloads.filter((download) => download.state !== "progress").length;

  return createPortal(
    <div
      ref={panelRef}
      id="downloads-popover"
      role="dialog"
      aria-label="Downloads"
      data-testid="downloads-popover"
      tabIndex={-1}
      className={cn(
        "no-drag fixed z-80 flex flex-col overflow-hidden rounded-lg border border-alpha-400 bg-background-100 text-gray-1000 shadow-modal outline-none",
        ready && position !== null ? "animate-overlay-in" : "pointer-events-none opacity-0",
      )}
      style={{
        top: position?.top,
        bottom: position?.bottom,
        left: position?.left ?? 0,
        width: POPOVER_W,
        maxHeight: POPOVER_MAX_H,
      }}
    >
      <header className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-[-0.01em]">Downloads</h2>
        {settled > 0 ? (
          <Button size="xs" variant="tertiary" data-testid="downloads-clear" onClick={() => void run({ type: "clearDownloads" })}>
            Clear
          </Button>
        ) : null}
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={close}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-1000 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-green-700"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </header>
      {downloads.length === 0 ? (
        <p className="px-4 pb-4 text-[12px] text-gray-700">Nothing downloaded yet. Files you download from any tab are listed here.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {downloads.map((download) => (
            <DownloadRow key={download.id} download={download} />
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

function DownloadRow({ download }: { download: BrowserDownload }) {
  const run = useAppStore((state) => state.browserControl);
  const live = download.state === "progress";
  const failed = download.state === "cancelled" || download.state === "interrupted" || download.state === "blocked";
  const percent = live && download.totalBytes > 0 ? Math.min(100, (download.receivedBytes / download.totalBytes) * 100) : null;
  const host = displayHost(download.origin === "" ? download.url : download.origin);
  return (
    <li data-testid="download-row" data-state={download.state} className="group flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-alpha-100">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full [&_svg]:size-3.5",
          download.state === "completed" ? "bg-green-100 text-green-900" : failed ? "bg-amber-100 text-amber-900" : "bg-blue-100 text-blue-900",
        )}
      >
        {download.state === "completed" ? <Check /> : <ArrowDownToLine className={live ? "animate-pulse" : undefined} />}
      </span>
      <span className="min-w-0 flex-1">
        {download.state === "completed" ? (
          <button
            type="button"
            title="Open"
            onClick={() => void run({ type: "openDownload", downloadId: download.id })}
            className="block max-w-full cursor-pointer truncate text-left text-label-13 font-medium hover:underline"
          >
            {download.fileName}
          </button>
        ) : (
          <span className="block truncate text-label-13 font-medium">{download.fileName}</span>
        )}
        <span className="block truncate text-[11.5px] text-gray-700">
          {downloadStatusLine(download)}
          {host.length > 0 ? ` · ${host}` : ""}
        </span>
        {percent !== null ? (
          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-gray-200">
            <span className="block h-full bg-blue-700 transition-[width]" style={{ width: `${String(percent)}%` }} />
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {download.state === "completed" ? (
          <RowButton label="Show in folder" onClick={() => void run({ type: "showDownload", downloadId: download.id })}>
            <FolderOpen />
          </RowButton>
        ) : null}
        {download.state === "cancelled" || download.state === "interrupted" ? (
          <RowButton label="Retry" onClick={() => void run({ type: "retryDownload", downloadId: download.id })}>
            <RotateCw />
          </RowButton>
        ) : null}
        {live ? (
          <RowButton label="Cancel" onClick={() => void run({ type: "cancelDownload", downloadId: download.id })}>
            <X />
          </RowButton>
        ) : (
          <RowButton label="Remove from list" onClick={() => void run({ type: "removeDownload", downloadId: download.id })}>
            <X />
          </RowButton>
        )}
      </span>
    </li>
  );
}

function RowButton({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-6 cursor-pointer place-items-center rounded-sm text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-1000 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-green-700 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}
