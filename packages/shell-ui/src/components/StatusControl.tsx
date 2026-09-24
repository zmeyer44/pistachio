import { ChevronRight, CircleUserRound, Cloud, Globe, Monitor, RefreshCw, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import type { ThreadListItem } from "@pistachio/protocol";
import type { SettingsSection } from "@pistachio/shell-contracts/settings";
import { planesFor, type PlaneRow, type StatusTone } from "../lib/chrome-status";
import { cn } from "../lib/cn";
import { statusLabel } from "../lib/run";
import { displayHost } from "../lib/url";
import { useAppStore } from "../store";
import { useShell } from "../chrome/shell-host";
import { useSurface, type SurfaceRendering } from "../surface";

export interface BrowserStatus {
  rendering: SurfaceRendering | null;
  /** Permissions and actions the policy blocks on the active site. */
  blocked: number;
  /** Permission and passkey requests awaiting the person's review. */
  pending: number;
  /** An agent run is in progress (null between runs). */
  running: boolean;
  /** "Human session", or the run's status. */
  session: string;
  /** The active site's host, or a placeholder. */
  site: string;
  /** The one-line verdict on the site: review count, block count, connection, or "Protected". */
  siteState: string;
  /**
   * The account, cloud and egress planes as rows (lib/chrome-status.ts).
   * They replaced two rows that stated "Hosted control · Connected" and
   * "Deterministic policy · Active" whatever was true — claims nothing
   * behind them could confirm, on a card whose whole job is to be trusted.
   */
  planes: PlaneRow[];
}

const EMPTY_THREADS: ThreadListItem[] = [];

/** Browser trust state, summarised once for every control that shows it. */
export function useBrowserStatus(): BrowserStatus {
  const controls = useAppStore((state) => state.browserControls);
  const runStatus = useAppStore((state) => state.snapshot?.run?.status ?? null);
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
  return useMemo(() => {
    const blocked =
      controls === null
        ? 0
        : Object.values(controls.permissions).filter((item) => item.decision === "block").length +
          Object.values(controls.actions).filter((item) => item.decision === "block").length;
    const pending = controls === null ? 0 : controls.pendingPermissions.length + controls.pendingPasskeyRequests.length;
    return {
      rendering,
      blocked,
      pending,
      planes: planesFor({ account, sync, cloud, egress, activeSpaceId, threads, accountUrl }, surface.kind),
      running: runStatus !== null,
      session: runStatus === null ? "Human session" : statusLabel(runStatus),
      site: controls?.origin === undefined || controls.origin === "" ? "No active site" : displayHost(controls.origin),
      siteState:
        pending > 0
          ? `${pending} awaiting review`
          : blocked > 0
            ? `${blocked} blocked by policy`
            : controls?.secure === false
              ? "Review connection"
              : "Protected",
    };
  }, [controls, runStatus, account, sync, cloud, egress, activeSpaceId, threads, surface.kind, accountUrl, rendering]);
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

/** The corner dot on a status button: amber while something awaits review, pulsing while a run is on. */
export function StatusDot({ status, className }: { status: BrowserStatus; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 rounded-full ring-2 ring-(--chrome-surface)",
        status.pending > 0 ? "bg-amber-700" : "bg-green-700",
        status.running && "animate-pulse-dot",
        className,
      )}
    />
  );
}

/**
 * One compact home for browser trust state. Hover or focus raises the shell
 * above the native page views and reveals the detail card; click keeps the
 * old direct route into the full Site controls page.
 */
export function StatusControl({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const status = useBrowserStatus();
  const open = useAppStore((state) => state.overlay === "status");
  const openStatusCard = useAppStore((state) => state.openStatusCard);
  const closeStatusCard = useAppStore((state) => state.closeStatusCard);
  const { run } = useShell();
  const { pending, session, site, siteState } = status;

  const openSiteControls = () => {
    closeStatusCard();
    run({ type: "openSiteControls" });
  };

  /** A plane row is a way into the page that can change it, not a read-out. */
  const openPlane = (section: SettingsSection) => {
    closeStatusCard();
    run({ type: "openSettings", section });
  };

  return (
    <div
      className="no-drag relative flex shrink-0"
      onPointerEnter={openStatusCard}
      onPointerLeave={closeStatusCard}
      onFocusCapture={openStatusCard}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeStatusCard();
      }}
    >
      <button
        type="button"
        data-testid="site-controls-button"
        aria-label="Browser status and site controls"
        aria-expanded={open}
        aria-controls="browser-status-card"
        onClick={openSiteControls}
        className={cn(
          "group relative grid size-6 cursor-pointer place-items-center rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700",
          pending > 0
            ? "bg-amber-100 text-amber-900 hover:bg-amber-200"
            : open
              ? "bg-green-100 text-green-900"
              : "text-gray-900 hover:bg-alpha-200 hover:text-gray-1000",
        )}
      >
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        <StatusDot status={status} className="absolute top-0.5 right-0.5" />
      </button>

      {open ? (
        <div
          className={cn(
            "absolute z-80",
            orientation === "horizontal" ? "top-full right-0 w-64 pt-2" : "bottom-full left-0 w-48 pb-2",
          )}
        >
          <section
            id="browser-status-card"
            data-testid="status-hover-card"
            aria-label="Browser status"
            className="animate-overlay-in overflow-hidden rounded-lg border border-alpha-400 bg-background-100 text-gray-1000 shadow-modal"
          >
            <header className="border-b border-alpha-400 bg-green-100/60 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-full bg-green-200 text-green-900">
                  <ShieldCheck className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[12.5px] font-semibold tracking-[-0.01em]">Browser status</h2>
                  <p className="truncate text-[10.5px] text-gray-700">{pending > 0 ? "Review needed" : "Protection is active"}</p>
                </div>
              </div>
            </header>

            <div className="divide-y divide-alpha-300 px-2">
              <RenderingStatus rendering={status.rendering} />
              <StatusRow icon={<CircleUserRound />} label="Session" value={session} />
              {status.planes.map((plane) => (
                <StatusRow
                  key={plane.id}
                  icon={PLANE_ICON[plane.id]}
                  label={plane.label}
                  value={plane.value}
                  note={plane.note}
                  tone={plane.tone}
                  testId={`status-plane-${plane.id}`}
                  href={plane.href}
                  onSelect={() => openPlane(plane.section)}
                />
              ))}
            </div>

            <button
              type="button"
              data-testid="status-site-controls"
              onClick={openSiteControls}
              className="group flex w-full cursor-pointer items-center gap-2 border-t border-alpha-400 px-3 py-2.5 text-left outline-none transition-colors hover:bg-alpha-100 focus-visible:bg-alpha-100"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-sm bg-gray-100 text-gray-900">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11.5px] font-medium">Site controls</span>
                <span className="block truncate text-[10px] text-gray-700">{site} · {siteState}</span>
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-gray-700 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

const PLANE_ICON: Record<PlaneRow["id"], React.ReactNode> = {
  identity: <RefreshCw />,
  cloud: <Cloud />,
  egress: <Globe />,
  managed: <CircleUserRound />,
};

const PLANE_TONE: Record<StatusTone, string> = {
  green: "text-green-900",
  amber: "text-amber-900",
  red: "text-red-900",
  blue: "text-blue-900",
  gray: "text-gray-700",
};

/**
 * One line of the card. A row with somewhere to go is a button — the plane
 * rows carry the settings page that can change what they report — and a row
 * that only states a fact stays a div, so nothing invites a click that does
 * nothing.
 */
function StatusRow({
  icon,
  label,
  value,
  note,
  tone = "green",
  testId,
  href = null,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note?: string;
  tone?: StatusTone;
  testId?: string;
  /** An address on another site; it wins over `onSelect` and opens a tab. */
  href?: string | null;
  onSelect?: () => void;
}) {
  const body = (
    <>
      <span className={cn("grid size-5 shrink-0 place-items-center [&_svg]:size-3.5", PLANE_TONE[tone])} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] text-gray-800">{label}</span>
      <span className="max-w-24 truncate text-right text-[10.5px] font-medium text-gray-1000">{value}</span>
    </>
  );
  if (href !== null) {
    // A real anchor, not a button that calls `window.open`: the destination is
    // another site, and a reader should be able to see and copy where a row
    // is about to send them.
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={note}
        aria-label={`${label}: ${value}${note === undefined ? "" : `. ${note}`}`}
        data-testid={testId}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-left outline-none transition-colors hover:bg-alpha-100 focus-visible:bg-alpha-100"
      >
        {body}
      </a>
    );
  }
  if (onSelect === undefined) {
    return <div className="flex min-h-9 items-center gap-2 px-1 py-1.5">{body}</div>;
  }
  return (
    <button
      type="button"
      title={note}
      aria-label={`${label}: ${value}${note === undefined ? "" : `. ${note}`}`}
      data-testid={testId}
      onClick={onSelect}
      className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-left outline-none transition-colors hover:bg-alpha-100 focus-visible:bg-alpha-100"
    >
      {body}
    </button>
  );
}
