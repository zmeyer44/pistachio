import { Fingerprint, KeyRound, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PendingPasskeyRequest, PendingPermissionRequest } from "@pistachio/shell-contracts/browser-controls";
import { displayHost } from "../lib/url";
import { useAppStore } from "../store";
import { PERMISSION_ICONS, PERMISSION_REQUESTS, requestAnswerLabels, requestQuestion } from "./permission-meta";
import { Button } from "./ui/button";

/**
 * A site's request — location, the clipboard, the camera, a passkey — as a
 * compact dialog over the page rather than a page of its own. The page stays
 * in view behind a light veil (the surface's stills, like a Glance), so the
 * person keeps their bearings: they can see what asked, answer, and be back
 * on the page untouched, with nothing to close or navigate back from.
 *
 * The store raises it (`overlay: "permission"`) when a NEW request lands
 * and lowers it when the last one is answered (lib/permission-prompt.ts).
 * Escape, the veil, or the corner X put it down WITHOUT answering: the
 * request stays pending — Chromium waits, and main blocks it after a minute
 * — and the site-info button turns amber so it can be picked up from there
 * or from the full Site controls page.
 */
export function PermissionPromptDialog() {
  const controls = useAppStore((state) => state.browserControls);
  const close = useAppStore((state) => state.closePermissionPrompt);
  const openSiteControls = useAppStore((state) => state.openSiteControls);
  const run = useAppStore((state) => state.browserControl);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  if (controls === null) return null;
  const permissions = controls.pendingPermissions;
  const passkeys = controls.pendingPasskeyRequests;
  if (permissions.length === 0 && passkeys.length === 0) return null;

  const lead = permissions[0] ?? null;
  // The request names who asked: a Glance over the tab is another site's page.
  const asker = lead?.origin ?? controls.origin;
  const host = asker === "" ? "This page" : displayHost(asker);
  const title =
    lead !== null
      ? `${host} wants to ${requestPhrase(lead)}`
      : `Choose a passkey for ${passkeys[0]!.relyingPartyId}`;
  const count = permissions.length + passkeys.length;

  return (
    <div
      className="animate-backdrop-in absolute inset-0 z-30 grid place-items-center rounded-md bg-[oklch(0_0_0/0.22)] p-5"
      data-testid="permission-prompt-backdrop"
      onPointerDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-prompt-title"
        data-testid="permission-prompt"
        tabIndex={-1}
        className="animate-overlay-in w-full max-w-[460px] overflow-hidden rounded-lg bg-background-100 text-gray-1000 shadow-modal outline-none"
      >
        <header className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-900 [&_svg]:size-4">
            {lead !== null ? PERMISSION_ICONS[lead.permission] : <Fingerprint />}
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 id="permission-prompt-title" className="text-label-14 font-semibold leading-snug">
              {title}
            </h2>
            <p className="mt-0.5 text-copy-12 text-gray-700">
              {count > 1
                ? `${count} requests are paused until you decide.`
                : lead?.externalApp !== undefined
                  ? `Always allow lets this site open ${lead.externalApp.scheme} links without asking again.`
                  : "The site is paused until you decide. Close this to answer later."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Decide later"
            title="Decide later"
            onClick={close}
            className="-mr-1 -mt-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-1000 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-green-700"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-2 px-5 pb-4">
          {permissions.map((request, index) => (
            <PermissionRow
              key={request.id}
              request={request}
              // The lead request is named in the title; the rest name themselves.
              named={index > 0 || passkeys.length > 0}
              onDecide={(decision) => void run({ type: "resolvePermission", requestId: request.id, decision })}
            />
          ))}
          {passkeys.map((request) => (
            <PasskeyChooser
              key={request.id}
              request={request}
              named={lead !== null}
              onSelect={(accountId) => void run({ type: "selectPasskey", requestId: request.id, accountId })}
            />
          ))}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-alpha-400 bg-alpha-100 px-5 py-2.5">
          <button
            type="button"
            data-testid="permission-prompt-site-controls"
            onClick={() => {
              close();
              openSiteControls();
            }}
            className="flex cursor-pointer items-center gap-1.5 rounded-sm text-copy-12 text-gray-700 transition-colors hover:text-gray-1000 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700"
          >
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Site controls
          </button>
          <span className="text-copy-12 text-gray-600">Esc to decide later</span>
        </footer>
      </div>
    </div>
  );
}

/** "use your camera and microphone": one Chromium media request may carry both. */
function requestPhrase(request: PendingPermissionRequest): string {
  if (request.externalApp !== undefined) return `open ${request.externalApp.appName}`;
  const phrases = request.permissions.map((permission) => PERMISSION_REQUESTS[permission]);
  if (phrases.length === 1) return phrases[0]!;
  // "use your camera" + "use your microphone" → "use your camera and microphone".
  const [first, ...rest] = phrases;
  const words = rest.map((phrase) => phrase.replace(/^use your /, ""));
  return phrases.every((phrase) => phrase.startsWith("use your "))
    ? `${first!} and ${words.join(" and ")}`
    : phrases.join(" and ");
}

function PermissionRow({
  request,
  named,
  onDecide,
}: {
  request: PendingPermissionRequest;
  named: boolean;
  onDecide(decision: "block" | "allow-once" | "allow"): void;
}) {
  const labels = requestAnswerLabels(request);
  const question = requestQuestion(request);
  return (
    <div
      role="group"
      data-testid="permission-prompt-request"
      aria-label={question.replace(/\?$/, "")}
      className="flex flex-wrap items-center gap-2"
    >
      {named ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-label-13 font-medium">
          <span className="grid size-5 shrink-0 place-items-center text-gray-800 [&_svg]:size-4" aria-hidden="true">
            {PERMISSION_ICONS[request.permission]}
          </span>
          <span className="truncate">{question}</span>
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="flex shrink-0 gap-1.5">
        <Button variant="tertiary" onClick={() => onDecide("block")}>
          {labels.block}
        </Button>
        <Button variant="secondary" onClick={() => onDecide("allow-once")}>
          {labels.once}
        </Button>
        <Button onClick={() => onDecide("allow")}>{labels.always}</Button>
      </span>
    </div>
  );
}

function PasskeyChooser({
  request,
  named,
  onSelect,
}: {
  request: PendingPasskeyRequest;
  named: boolean;
  onSelect(accountId: string | null): void;
}) {
  return (
    <div
      role="group"
      data-testid="passkey-account-chooser"
      aria-label={`Choose a passkey for ${request.relyingPartyId}`}
      className="overflow-hidden rounded-md border border-alpha-400"
    >
      <div className="flex items-center gap-2 bg-alpha-100 px-3 py-2">
        {named ? <Fingerprint className="size-4 shrink-0 text-gray-800" aria-hidden="true" /> : null}
        <span className="min-w-0 flex-1 truncate text-copy-12 text-gray-800">
          {named ? `Choose a passkey for ${request.relyingPartyId}` : "Select the account you intended to use."}
        </span>
        <Button variant="tertiary" size="xs" onClick={() => onSelect(null)}>
          Cancel
        </Button>
      </div>
      <div className="grid gap-px border-t border-alpha-400 bg-alpha-400 sm:grid-cols-2">
        {request.accounts.map((account) => (
          <button
            key={account.id}
            type="button"
            className="group flex min-w-0 cursor-pointer items-center gap-3 bg-background-100 px-3 py-2.5 text-left transition-colors hover:bg-green-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-green-700"
            onClick={() => onSelect(account.id)}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-gray-300 bg-gray-100 text-gray-800 group-hover:border-green-400 group-hover:bg-green-100">
              <KeyRound className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-label-13 font-semibold text-gray-1000">{account.displayName}</span>
              <span className="block truncate text-copy-12 text-gray-700">{account.name}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
