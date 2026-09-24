import { ChevronRight, Lock, LockOpen, Minus, Plus, ShieldCheck, SlidersHorizontal, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BROWSER_PERMISSIONS,
  type BrowserControlsSnapshot,
  type BrowserPermission,
  type BrowserPolicyVerdict,
  type PermissionDecision,
} from "@pistachio/shell-contracts/browser-controls";
import { chromeIconButtonClass } from "../chrome/actions";
import { useShell } from "../chrome/shell-host";
import { cn } from "../lib/cn";
import { displayHost } from "../lib/url";
import { useAppStore } from "../store";
import { PERMISSION_ICONS, PERMISSION_LABELS, requestAnswerLabels, requestQuestion } from "./permission-meta";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

/**
 * Chrome's "view site information" for the active tab: a button on the
 * active tab in the strip (the strip's omnibox), or beside the bookmark
 * button in the sidebar layout's pane toolbar — and, on click, a compact
 * popover under it with the things a person flips in a hurry: the connection
 * verdict, per-permission switches (microphone, camera, …), this tab's
 * sound, and zoom, with a way into the full Site controls page for
 * everything else.
 *
 * The popover is a shell overlay (`overlay: "site-info"`): main paints stills
 * of the pages and hides the native tab views for as long as it is up, the
 * same way the tab's context menu works, so a card can hang below the strip
 * over the page at all. It is portalled to the body and positioned fixed
 * from the button's box, so neither the strip's stacking (the active tab is
 * its own z-index context) nor the sidebar column's clipping and transform
 * can catch it.
 *
 * A switch is two-state like Chrome's: ON allows, OFF blocks. "Ask", the
 * default, reads as off with a note, and "Reset permissions" is the way back
 * to it — the same `setPermission` / `clearPermissions` commands the full
 * page runs, so the two never disagree about what a site may do.
 */

const POPOVER_W = 300;
const EDGE = 8;
const GAP = 6;

/**
 * The permissions the popover always lists, decided or not — the ones a
 * person most often needs to flip on the spot. Every other permission
 * appears once this site has asked for it or has a decision on record (a
 * default verdict is not one, whichever way it goes: the clipboard is
 * allowed by default and would otherwise sit in every site's card).
 */
const QUICK_PERMISSIONS: readonly BrowserPermission[] = ["camera", "microphone", "geolocation", "notifications"];

/** Which permissions the popover lists for this snapshot, in the shared order. */
export function popoverPermissions(controls: BrowserControlsSnapshot): BrowserPermission[] {
  const requested = new Set<string>();
  for (const event of controls.recentEvents) requested.add(event.capability);
  for (const request of controls.pendingPermissions) for (const permission of request.permissions) requested.add(permission);
  return BROWSER_PERMISSIONS.filter((permission) => {
    const verdict = controls.permissions[permission];
    return QUICK_PERMISSIONS.includes(permission) || verdict.source !== "default" || requested.has(permission);
  });
}

/** The note under a permission row: who decided, or what happens next. */
export function permissionNote(verdict: BrowserPolicyVerdict<PermissionDecision>): string {
  if (verdict.source === "managed") return "Set by your organization";
  if (verdict.source === "task") return "Set by the task capsule";
  switch (verdict.decision) {
    case "allow":
      return "Allowed";
    case "block":
      return "Blocked";
    case "ask":
      return "Asks before use";
  }
}

export function SiteInfoButton({ variant }: { variant: "tab" | "pane" }) {
  const controls = useAppStore((state) => state.browserControls);
  const open = useAppStore((state) => state.overlay === "site-info");
  const toggle = useAppStore((state) => state.toggleSiteInfo);
  const close = useAppStore((state) => state.closeSiteInfo);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The tab the popover opened for: a switch of the active tab closes it,
  // since every row would otherwise silently start describing another site.
  const openedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (openedFor.current === null) openedFor.current = controls?.tabId ?? null;
    else if (openedFor.current !== (controls?.tabId ?? null)) close();
  }, [open, controls?.tabId, close]);
  useEffect(() => {
    if (!open) openedFor.current = null;
  }, [open]);
  // This button is going away (the tab lost focus, the layout changed): the
  // popover it owns goes with it.
  useEffect(
    () => () => {
      if (useAppStore.getState().overlay === "site-info") useAppStore.getState().closeSiteInfo();
    },
    [],
  );

  const pending = controls === null ? 0 : controls.pendingPermissions.length;
  const attention = pending > 0 || (controls !== null && controls.tabId !== null && !controls.secure);
  const label = "Site information and permissions";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="site-info-button"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "site-info-popover" : undefined}
        onClick={(event) => {
          // Inside the active tab: a tab press activates or drags, and
          // Enter activates — none of which this button means.
          event.stopPropagation();
          toggle();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className={
          variant === "pane"
            ? // The pane toolbar's own 24px button; amber while something needs a look.
              chromeIconButtonClass({ enabled: true, pressed: open }, attention && !open ? "text-amber-900 hover:bg-amber-100" : undefined)
            : cn(
                "no-drag -mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700",
                attention
                  ? "text-amber-900 hover:bg-amber-100"
                  : open
                    ? "bg-alpha-200 text-gray-1000"
                    : "text-gray-700 hover:bg-alpha-200 hover:text-gray-1000",
              )
        }
      >
        <SlidersHorizontal className={variant === "tab" ? "size-3" : "size-3.5"} aria-hidden="true" />
      </button>
      {open && controls !== null ? (
        // On a tab the card hangs from the button's left edge, like Chrome's;
        // on the pane toolbar the button is at the row's right end, so the
        // card hangs from its right edge and grows toward the page.
        <SiteInfoPopover controls={controls} triggerRef={triggerRef} align={variant === "pane" ? "end" : "start"} onClose={close} />
      ) : null}
    </>
  );
}

function SiteInfoPopover({
  controls,
  triggerRef,
  align,
  onClose,
}: {
  controls: BrowserControlsSnapshot;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Which edge of the button the card lines up with. */
  align: "start" | "end";
  onClose(): void;
}) {
  const ready = useAppStore((state) => state.overlayReady);
  const run = useAppStore((state) => state.browserControl);
  const { run: runShell } = useShell();
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Under the button, on its aligned edge, kept inside the window.
  // Re-measured on resize: the strip and the pane toolbar reflow with the
  // window and the button moves with them.
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const left = align === "start" ? rect.left - 4 : rect.right + 4 - POPOVER_W;
    setPosition({
      top: rect.bottom + GAP,
      left: Math.max(EDGE, Math.min(left, window.innerWidth - POPOVER_W - EDGE)),
    });
  }, [triggerRef, align]);
  useLayoutEffect(() => {
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);

  // Focus lands in the panel so Escape and Tab work from the start; Escape
  // hands it back to the button. Capture-phase, so the page's own Escape
  // handlers (the tab strip's, say) stay out of it.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    const trigger = triggerRef.current;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panelRef.current?.contains(event.target) === true || trigger?.contains(event.target) === true) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      trigger?.focus();
    };
    const onBlur = () => onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose, triggerRef]);

  const openSiteControls = () => {
    onClose();
    runShell({ type: "openSiteControls" });
  };

  const host = controls.origin === "" ? "This page" : displayHost(controls.origin);
  const noSite = controls.tabId === null;
  const locked = controls.tabKind === "agent";
  const permissions = popoverPermissions(controls);
  const managed = permissions.some((permission) => controls.permissions[permission].source === "managed");
  const userDecided = permissions.some((permission) => controls.permissions[permission].source === "user");

  return createPortal(
    <div
      ref={panelRef}
      id="site-info-popover"
      role="dialog"
      aria-label={`Site information for ${host}`}
      data-testid="site-info-popover"
      tabIndex={-1}
      className={cn(
        "no-drag fixed z-80 flex flex-col overflow-hidden rounded-lg border border-alpha-400 bg-background-100 text-gray-1000 shadow-modal outline-none",
        ready && position !== null ? "animate-overlay-in" : "pointer-events-none opacity-0",
      )}
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, width: POPOVER_W }}
    >
      <header className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-[-0.01em]">{host}</h2>
        {managed ? <Badge size="sm">Managed</Badge> : null}
        {controls.tabKind === "agent" ? (
          <Badge variant="blue-subtle" size="sm">
            Task capsule
          </Badge>
        ) : null}
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-1000 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-green-700"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </header>

      {noSite ? (
        <p className="px-4 pb-4 text-[12px] text-gray-700">No active site.</p>
      ) : (
        <>
          <div className="px-2">
            <NavRow
              testId="site-info-connection"
              icon={controls.secure ? <Lock /> : <LockOpen />}
              tone={controls.secure ? "default" : "amber"}
              label={controls.secure ? "Connection is secure" : "Connection is not secure"}
              onSelect={openSiteControls}
            />
          </div>

          <Rule />

          {controls.pendingPermissions.length > 0 ? (
            <>
              <div className="space-y-2 px-3 py-2">
                {controls.pendingPermissions.map((request) => (
                  <div
                    key={request.id}
                    role="alert"
                    data-testid="site-info-pending"
                    className="rounded-md border border-amber-400 bg-amber-100 px-3 py-2"
                  >
                    <p className="text-[12px] font-medium text-gray-1000">
                      {requestQuestion(request)}
                    </p>
                    <div className="mt-2 flex justify-end gap-1.5">
                      <Button
                        size="xs"
                        variant="tertiary"
                        onClick={() => void run({ type: "resolvePermission", requestId: request.id, decision: "block" })}
                      >
                        {requestAnswerLabels(request).block}
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => void run({ type: "resolvePermission", requestId: request.id, decision: "allow-once" })}
                      >
                        {requestAnswerLabels(request).once}
                      </Button>
                      <Button
                        size="xs"
                        onClick={() => void run({ type: "resolvePermission", requestId: request.id, decision: "allow" })}
                      >
                        Always
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Rule />
            </>
          ) : null}

          <div className="px-2 py-1">
            {permissions.map((permission) => {
              const verdict = controls.permissions[permission];
              const disabled = locked || verdict.source === "managed";
              return (
                <ToggleRow
                  key={permission}
                  testId={`site-info-permission-${permission}`}
                  icon={PERMISSION_ICONS[permission]}
                  label={PERMISSION_LABELS[permission]}
                  note={permissionNote(verdict)}
                  checked={verdict.decision === "allow"}
                  disabled={disabled}
                  onChange={(allow) =>
                    void run({ type: "setPermission", permission, decision: allow ? "allow" : "block" })
                  }
                />
              );
            })}
            <ToggleRow
              testId="site-info-sound"
              icon={controls.muted ? <VolumeX /> : <Volume2 />}
              label="Sound"
              note={controls.muted ? "Muted in this tab" : "Allowed in this tab"}
              checked={!controls.muted}
              onChange={() => void run({ type: "toggleMute" })}
            />
            <div className="flex min-h-10 items-center gap-3 px-2 py-1.5" data-testid="site-info-zoom">
              <span className="grid size-5 shrink-0 place-items-center text-gray-800 [&_svg]:size-4" aria-hidden="true">
                <ZoomGlyph />
              </span>
              <span className="min-w-0 flex-1 text-[12.5px] font-medium">Zoom</span>
              <span className="flex items-center rounded-md shadow-border">
                <button
                  type="button"
                  aria-label="Zoom out"
                  title="Zoom out"
                  onClick={() => void run({ type: "zoomOut" })}
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-l-md text-gray-800 transition-colors hover:bg-alpha-200 hover:text-gray-1000"
                >
                  <Minus className="size-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Reset zoom"
                  title="Reset zoom"
                  disabled={controls.zoomPercent === 100}
                  onClick={() => void run({ type: "zoomReset" })}
                  className="h-6 min-w-11 cursor-pointer px-1 font-mono text-[11px] tabular-nums text-gray-900 transition-colors hover:bg-alpha-200 disabled:cursor-default disabled:text-gray-700 disabled:hover:bg-transparent"
                >
                  {controls.zoomPercent}%
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  title="Zoom in"
                  onClick={() => void run({ type: "zoomIn" })}
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-r-md text-gray-800 transition-colors hover:bg-alpha-200 hover:text-gray-1000"
                >
                  <Plus className="size-3" aria-hidden="true" />
                </button>
              </span>
            </div>
            {userDecided && !locked ? (
              <div className="px-2 pt-1 pb-2">
                <Button
                  variant="secondary"
                  size="xs"
                  shape="circle"
                  data-testid="site-info-reset"
                  className="px-3"
                  onClick={() => void run({ type: "clearPermissions" })}
                >
                  Reset permissions
                </Button>
              </div>
            ) : null}
          </div>

          <Rule />

          <div className="px-2 pt-1 pb-2">
            <NavRow
              testId="site-info-site-controls"
              icon={<ShieldCheck />}
              label="Site controls"
              note="Permissions, data movement, passkeys, downloads"
              onSelect={openSiteControls}
            />
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

function Rule() {
  return <span aria-hidden="true" className="mx-4 my-1 h-px shrink-0 bg-alpha-400" />;
}

/** A row that goes somewhere: the connection verdict, the full page. */
function NavRow({
  icon,
  label,
  note,
  tone = "default",
  testId,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  note?: string;
  tone?: "default" | "amber";
  testId?: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onSelect}
      className="group flex min-h-10 w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-alpha-100 focus-visible:bg-alpha-100"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-5 shrink-0 place-items-center [&_svg]:size-4",
          tone === "amber" ? "text-amber-900" : "text-gray-800",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[12.5px] font-medium", tone === "amber" && "text-amber-900")}>{label}</span>
        {note === undefined ? null : <span className="block truncate text-[11px] text-gray-700">{note}</span>}
      </span>
      <ChevronRight
        className="size-3.5 shrink-0 text-gray-700 transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </button>
  );
}

/** A row with a switch: a permission, or this tab's sound. */
function ToggleRow({
  icon,
  label,
  note,
  checked,
  disabled = false,
  testId,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  note: string;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onChange(value: boolean): void;
}) {
  return (
    <div data-testid={testId} className="flex min-h-10 items-center gap-3 px-2 py-1.5">
      <span
        aria-hidden="true"
        className={cn("grid size-5 shrink-0 place-items-center [&_svg]:size-4", disabled ? "text-gray-600" : "text-gray-800")}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[12.5px] font-medium", disabled && "text-gray-700")}>{label}</span>
        <span className="block truncate text-[11px] text-gray-700">{note}</span>
      </span>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** A magnifier with a plus — lucide's ZoomIn is the "zoom in" button's glyph, so the row's own is drawn here. */
function ZoomGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8 11h6" />
    </svg>
  );
}
