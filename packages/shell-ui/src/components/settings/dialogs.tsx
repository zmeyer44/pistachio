/**
 * Modal dialogs raised from inside a settings page, cloned from
 * components/SpaceForkDialog.tsx: the same icon-tile header, the same
 * scrolling body, the same recessed footer with the explanation on the left
 * and the actions on the right.
 *
 * These sit INSIDE the settings page rather than in the shell's overlay
 * stack. Settings is already the one raised Overlay, so a sheet drawn over
 * it needs no second `overlay` state — and must not take one, or opening it
 * would close the page it belongs to.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "../ui/button";
import { Note } from "../ui/note";

/**
 * The empty layer SettingsPage keeps at its own root for these sheets. A
 * dialog raised from deep inside a section would otherwise be clipped by the
 * fieldset it sits in and by the content column's scroller, so it is
 * portalled here — one hop, still inside the settings page.
 */
export const SETTINGS_DIALOG_HOST_ID = "settings-dialog-host";

export function SettingsDialog({
  icon,
  title,
  subtitle,
  tone = "neutral",
  busy = false,
  onClose,
  footer,
  actions,
  testId,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  /** `danger` reddens the icon tile: the dialog is asking for something irreversible. */
  tone?: "neutral" | "danger";
  busy?: boolean;
  onClose: () => void;
  /** Footer prose, across from the actions. */
  footer?: React.ReactNode;
  actions: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  // Read once, during the first render: the host is already in the document
  // (the page mounted before this sheet), so there is no frame of the dialog
  // painted in the wrong place before the portal takes it.
  const [host] = useState(() => document.getElementById(SETTINGS_DIALOG_HOST_ID));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The settings page closes on Escape too, and its listener is on this
      // same window. Capturing first and stopping propagation is what keeps
      // one Escape from dismissing both the sheet and the page under it —
      // including while the sheet is busy, when it dismisses neither.
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onClose]);

  const titleId = `${testId}-title`;
  const content = (
    <div
      className="animate-backdrop-in pointer-events-auto absolute inset-0 z-30 grid place-items-center rounded-md bg-[oklch(0_0_0/0.36)] p-5"
      data-testid={`${testId}-backdrop`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className="w-full max-w-[560px] overflow-hidden rounded-lg bg-background-100 shadow-[0_24px_80px_oklch(0_0_0/0.28),0_0_0_1px_var(--color-alpha-400)]"
      >
        <header className="flex items-start gap-3 border-b border-alpha-400 px-5 py-4">
          <span
            className={
              tone === "danger"
                ? "mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-red-100 text-red-900 [&_svg]:size-4.5"
                : "mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-green-100 text-green-900 [&_svg]:size-4.5"
            }
          >
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <h1 id={titleId} className="text-heading-16 text-gray-1000">
              {title}
            </h1>
            {subtitle === undefined ? null : (
              <span className="mt-1 block text-label-12 leading-4.5 text-gray-900">{subtitle}</span>
            )}
          </span>
          <Button variant="tertiary" size="xs" svgOnly aria-label="Close" disabled={busy} onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="max-h-[min(620px,calc(100vh-190px))] space-y-4 overflow-y-auto px-5 py-5">{children}</div>
        <footer className="flex items-center justify-between gap-4 border-t border-alpha-400 bg-background-200 px-5 py-3">
          <span className="min-w-0 text-label-12 leading-4.5 text-gray-900">{footer}</span>
          <span className="flex shrink-0 items-center gap-2">{actions}</span>
        </footer>
      </div>
    </div>
  );
  return host === null ? content : createPortal(content, host);
}

/**
 * A dialog whose whole content is the consequence of one button. The body
 * says what the action DOES and what it does NOT do — the second half is the
 * part a person cannot infer, and the part revocation gets wrong everywhere.
 */
export function ConfirmDialog({
  icon,
  title,
  subtitle,
  does,
  doesNot,
  confirmLabel,
  confirmVariant = "error",
  busy = false,
  error,
  onClose,
  onConfirm,
  testId,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  /** What the action changes, one clause per line. */
  does: readonly string[];
  /** What it leaves exactly as it is. */
  doesNot: readonly string[];
  confirmLabel: string;
  confirmVariant?: "error" | "default" | "warning";
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
  testId: string;
  children?: React.ReactNode;
}) {
  return (
    <SettingsDialog
      icon={icon}
      title={title}
      subtitle={subtitle}
      tone={confirmVariant === "error" ? "danger" : "neutral"}
      busy={busy}
      onClose={onClose}
      testId={testId}
      footer="This is done on the control plane, not only on this Mac."
      actions={
        <>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant={confirmVariant} size="sm" loading={busy} onClick={onConfirm} data-testid={`${testId}-confirm`}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <ConsequenceList heading="What this does" items={does} tone="does" />
      <ConsequenceList heading="What this does not do" items={doesNot} tone="does-not" />
      {error === undefined || error === null || error === "" ? null : (
        <Note type="error" size="sm">
          {error}
        </Note>
      )}
    </SettingsDialog>
  );
}

export function ConsequenceList({
  heading,
  items,
  tone,
}: {
  heading: string;
  items: readonly string[];
  tone: "does" | "does-not";
}) {
  if (items.length === 0) return null;
  return (
    <section className="rounded-md bg-background-200 px-3.5 py-3 shadow-border">
      <h2 className="text-label-12 font-medium text-gray-1000">{heading}</h2>
      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-label-12 leading-4.5 text-gray-900">
            <span aria-hidden="true" className={tone === "does" ? "text-gray-1000" : "text-gray-700"}>
              {tone === "does" ? "→" : "·"}
            </span>
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
