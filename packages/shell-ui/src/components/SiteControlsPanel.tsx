import {
  Check,
  Clipboard,
  Download,
  FileUp,
  Fingerprint,
  KeyRound,
  Printer,
  ShieldCheck,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect } from "react";
import {
  BROWSER_PERMISSIONS,
  GUARDED_BROWSER_ACTIONS,
  type GuardedBrowserAction,
  type PermissionDecision,
} from "@pistachio/shell-contracts/browser-controls";
import { useAppStore } from "../store";
import { PERMISSION_ICONS, PERMISSION_LABELS, requestAnswerLabels, requestQuestion } from "./permission-meta";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select } from "./ui/select";

const ACTION_LABELS: Record<GuardedBrowserAction, string> = {
  download: "Downloads",
  upload: "File uploads",
  copy: "Copy from site",
  paste: "Paste into site",
  print: "Printing",
};

const ACTION_ICONS: Record<GuardedBrowserAction, React.ReactNode> = {
  download: <Download />,
  upload: <FileUp />,
  copy: <Clipboard />,
  paste: <Clipboard />,
  print: <Printer />,
};

const PERMISSION_ITEMS: ReadonlyArray<{
  value: PermissionDecision;
  label: string;
}> = [
  { value: "ask", label: "Ask" },
  { value: "allow", label: "Allow" },
  { value: "block", label: "Block" },
];

export function SiteControlsPanel() {
  const controls = useAppStore((state) => state.browserControls);
  // Whether `getBrowserControls` FAILED, as distinct from answering. The
  // neutral snapshot the store falls back to holds every guarded action
  // BLOCKED (store.ts), because "we could not ask" is not permission — and a
  // panel showing five denials with no explanation reads as a policy. This
  // is the explanation.
  const failed = useAppStore((state) => state.failed["getBrowserControls"] ?? null);
  const close = useAppStore((state) => state.closeSiteControls);
  const run = useAppStore((state) => state.browserControl);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  if (failed !== null) {
    return (
      <div className="grid h-full place-items-center rounded-md bg-background-100 p-6 shadow-small" data-testid="site-controls-failed">
        <p className="max-w-80 text-center text-copy-13 text-gray-900">
          Site controls could not be loaded, so nothing here is this site&rsquo;s policy. Copy, paste, downloads and
          printing are held back until they can be read again.
          <span className="mt-2 block text-gray-700">{failed}</span>
        </p>
      </div>
    );
  }

  if (controls === null || controls.tabId === null) {
    return (
      <div className="grid h-full place-items-center rounded-md bg-background-100 shadow-small">
        <p className="text-copy-13 text-gray-700">No active site.</p>
      </div>
    );
  }

  const managed =
    Object.values(controls.permissions).some((verdict) => verdict.source === "managed") ||
    Object.values(controls.actions).some((verdict) => verdict.source === "managed");
  return (
    <section
      aria-label="Site controls"
      data-testid="site-controls"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-background-100 shadow-small"
    >
      <header className="flex shrink-0 items-center gap-4 border-b border-gray-300 px-6 py-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-green-100 text-green-900">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-heading-18 font-semibold text-gray-1000">{controls.origin || "This page"}</h1>
            <Badge variant={controls.secure ? "green-subtle" : "amber-subtle"} size="sm">
              {controls.secure ? "Secure context" : "Not secure"}
            </Badge>
            {managed ? <Badge size="sm">Managed</Badge> : null}
            {controls.tabKind === "agent" ? (
              <Badge variant="blue-subtle" size="sm">
                Task capsule
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-copy-13 text-gray-700">
            Chromium capabilities and data movement are enforced before a site receives access.
          </p>
        </div>
        <Button aria-label="Close site controls" title="Close" variant="tertiary" svgOnly onClick={close}>
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {controls.pendingPasskeyRequests.map((request) => (
          <div
            key={request.id}
            role="alert"
            data-testid="passkey-account-chooser"
            className="mb-4 overflow-hidden rounded-md border border-green-400 bg-green-100"
          >
            <div className="flex items-start gap-4 px-4 py-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-full bg-green-200 text-green-900">
                <Fingerprint className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-label-14 font-semibold text-gray-1000">Choose a passkey for {request.relyingPartyId}</p>
                <p className="text-copy-12 text-gray-800">The site is paused. Select the account you intended to use.</p>
              </div>
              <Button
                variant="tertiary"
                size="xs"
                onClick={() => void run({ type: "selectPasskey", requestId: request.id, accountId: null })}
              >
                Cancel
              </Button>
            </div>
            <div className="grid gap-px border-t border-green-300 bg-green-300 sm:grid-cols-2">
              {request.accounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  className="group flex min-w-0 items-center gap-3 bg-background-100 px-4 py-3 text-left transition-colors hover:bg-green-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-green-700"
                  onClick={() => void run({ type: "selectPasskey", requestId: request.id, accountId: account.id })}
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
        ))}

        {controls.pendingPermissions.map((request) => (
          <div
            key={request.id}
            role="alert"
            className="mb-4 flex items-center gap-4 rounded-md border border-amber-400 bg-amber-100 px-4 py-3"
          >
            <div className="grid size-9 place-items-center rounded-full bg-amber-200 text-amber-900 [&_svg]:size-4">
              {PERMISSION_ICONS[request.permission]}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-label-14 font-semibold text-gray-1000">
                {requestQuestion(request)}
              </p>
              <p className="text-copy-13 text-gray-800">The request is paused until you decide.</p>
            </div>
            <Button
              variant="tertiary"
              onClick={() =>
                void run({
                  type: "resolvePermission",
                  requestId: request.id,
                  decision: "block",
                })
              }
            >
              {requestAnswerLabels(request).block}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                void run({
                  type: "resolvePermission",
                  requestId: request.id,
                  decision: "allow-once",
                })
              }
            >
              {requestAnswerLabels(request).once}
            </Button>
            <Button
              onClick={() =>
                void run({
                  type: "resolvePermission",
                  requestId: request.id,
                  decision: "allow",
                })
              }
            >
              Always allow
            </Button>
          </div>
        ))}

        <div className="grid grid-cols-[minmax(0,1.12fr)_minmax(300px,.88fr)] gap-5">
          <div className="min-w-0 space-y-5">
            <ControlSection
              title="Site permissions"
              description="Device and browser capabilities requested by this origin."
            >
              <div className="divide-y divide-gray-200">
                {BROWSER_PERMISSIONS.map((permission) => {
                  const verdict = controls.permissions[permission];
                  const locked = controls.tabKind === "agent" || verdict.source === "managed";
                  return (
                    <div key={permission} className="flex min-h-11 items-center gap-3 py-2">
                      <span className="grid size-7 place-items-center text-gray-700 [&_svg]:size-4">
                        {PERMISSION_ICONS[permission]}
                      </span>
                      <span className="min-w-0 flex-1 text-label-13 font-medium text-gray-1000">
                        {PERMISSION_LABELS[permission]}
                        {permission === "external-app" && verdict.decision === "ask" && controls.externalAppSchemes.length > 0 ? (
                          <span className="block truncate text-[11px] font-normal text-gray-700" data-testid="external-app-schemes">
                            Always opens {controls.externalAppSchemes.join(", ")} links. Reset site decisions to be asked again.
                          </span>
                        ) : null}
                      </span>
                      {verdict.source === "managed" || verdict.source === "task" ? (
                        <Badge size="sm">{verdict.source === "managed" ? "Managed" : "Task"}</Badge>
                      ) : null}
                      <Select
                        aria-label={`${PERMISSION_LABELS[permission]} permission`}
                        className="w-28"
                        value={verdict.decision}
                        items={PERMISSION_ITEMS}
                        disabled={locked}
                        onValueChange={(decision) =>
                          void run({
                            type: "setPermission",
                            permission,
                            decision,
                          })
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex justify-end">
                <Button
                  variant="tertiary"
                  size="xs"
                  disabled={controls.tabKind === "agent"}
                  onClick={() => void run({ type: "clearPermissions" })}
                >
                  Reset site decisions
                </Button>
              </div>
            </ControlSection>

            <ControlSection
              title="Data movement"
              description="Policy gates designed for managed browsing and future DLP inspection."
            >
              <div className="grid grid-cols-2 gap-2">
                {GUARDED_BROWSER_ACTIONS.map((action) => {
                  const verdict = controls.actions[action];
                  return (
                    <div
                      key={action}
                      data-testid={`policy-action-${action}`}
                      className="flex min-h-14 items-center gap-3 rounded-sm border border-gray-300 px-3"
                    >
                      <span className="text-gray-700 [&_svg]:size-4">{ACTION_ICONS[action]}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-label-13 font-medium text-gray-1000">{ACTION_LABELS[action]}</span>
                        <span className="block truncate text-[11px] capitalize text-gray-700">
                          {verdict.source} policy
                        </span>
                      </span>
                      <Badge variant={verdict.decision === "allow" ? "green-subtle" : "red-subtle"} size="sm">
                        {verdict.decision === "allow" ? <Check /> : <X />}
                        {verdict.decision}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </ControlSection>
          </div>

          <div className="min-w-0 space-y-5">
            <ControlSection title="Passkeys" description="Phishing-resistant sign-in using this device or a security key.">
              <div data-testid="passkey-status" className="flex items-start gap-3 rounded-sm border border-gray-300 bg-gray-50 p-3">
                <span
                  className={`grid size-9 shrink-0 place-items-center rounded-full ${controls.passkeys.platformAuthenticatorAvailable ? "bg-green-200 text-green-900" : "bg-gray-200 text-gray-700"}`}
                >
                  <Fingerprint className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-label-13 font-semibold text-gray-1000">
                      {controls.tabKind === "agent"
                        ? "Disabled for task tabs"
                        : controls.passkeys.platformAuthenticatorAvailable
                          ? "Device passkeys ready"
                          : controls.passkeys.webAuthnAvailable
                            ? "Passkeys supported"
                            : "Passkeys unavailable"}
                    </p>
                    {controls.passkeys.platformAuthenticatorAvailable ? (
                      <Badge variant="green-subtle" size="sm">Device ready</Badge>
                    ) : controls.passkeys.touchIdConfigured ? (
                      <Badge variant="amber-subtle" size="sm">Touch ID configured</Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-copy-12 text-gray-700">
                    {controls.tabKind === "agent"
                      ? "Delegated sessions cannot create, discover, or use a person's passkeys."
                      : controls.passkeys.platformAuthenticatorAvailable
                        ? "Supported sites can ask for your fingerprint, face, or device PIN. Authentication stays with the operating system."
                        : controls.passkeys.webAuthnAvailable
                          ? "Security keys can work here, but this device is not currently reporting a built-in biometric authenticator."
                          : "This page is not a secure WebAuthn context, or the browser capability is still loading."}
                  </p>
                </div>
              </div>
            </ControlSection>

            <ControlSection title="Page controls" description="Native Chromium controls for the selected tab.">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" svgOnly aria-label="Zoom out" onClick={() => void run({ type: "zoomOut" })}>
                  <ZoomOut />
                </Button>
                <Button
                  variant="tertiary"
                  className="min-w-16 font-mono"
                  onClick={() => void run({ type: "zoomReset" })}
                >
                  {controls.zoomPercent}%
                </Button>
                <Button variant="secondary" svgOnly aria-label="Zoom in" onClick={() => void run({ type: "zoomIn" })}>
                  <ZoomIn />
                </Button>
                <Button variant="secondary" prefix={<Volume2 />} onClick={() => void run({ type: "toggleMute" })}>
                  {controls.muted ? "Unmute" : "Mute"}
                </Button>
                <Button
                  variant="secondary"
                  prefix={<Printer />}
                  disabled={controls.actions.print.decision === "block"}
                  onClick={() => void run({ type: "print" })}
                >
                  Print
                </Button>
              </div>
            </ControlSection>

            <ControlSection title="Transfers" description="Downloads are tracked here even when policy blocks them.">
              {controls.downloads.length === 0 ? (
                <EmptyState>No downloads from this tab yet.</EmptyState>
              ) : (
                <div className="space-y-2">
                  {controls.downloads.slice(0, 6).map((download) => (
                    <div key={download.id} className="rounded-sm border border-gray-300 p-3">
                      <div className="flex items-center gap-2">
                        <Download className="size-4 shrink-0 text-gray-700" />
                        <span className="min-w-0 flex-1 truncate text-label-13 font-medium">{download.fileName}</span>
                        <Badge
                          variant={
                            download.state === "blocked" || download.state === "interrupted"
                              ? "red-subtle"
                              : "gray-subtle"
                          }
                          size="sm"
                        >
                          {download.state}
                        </Badge>
                      </div>
                      {download.state === "progress" && download.totalBytes > 0 ? (
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-gray-200">
                          <div
                            className="h-full bg-green-700"
                            style={{
                              width: `${Math.min(100, (download.receivedBytes / download.totalBytes) * 100)}%`,
                            }}
                          />
                        </div>
                      ) : null}
                      <div className="mt-2 flex justify-end gap-1">
                        {download.state === "progress" ? (
                          <Button
                            size="xs"
                            variant="tertiary"
                            onClick={() =>
                              void run({
                                type: "cancelDownload",
                                downloadId: download.id,
                              })
                            }
                          >
                            Cancel
                          </Button>
                        ) : download.state === "completed" ? (
                          <>
                            <Button
                              size="xs"
                              variant="tertiary"
                              onClick={() =>
                                void run({
                                  type: "openDownload",
                                  downloadId: download.id,
                                })
                              }
                            >
                              Open
                            </Button>
                            <Button
                              size="xs"
                              variant="tertiary"
                              onClick={() =>
                                void run({
                                  type: "showDownload",
                                  downloadId: download.id,
                                })
                              }
                            >
                              Show in folder
                            </Button>
                          </>
                        ) : download.state === "cancelled" || download.state === "interrupted" ? (
                          <Button
                            size="xs"
                            variant="tertiary"
                            onClick={() =>
                              void run({
                                type: "retryDownload",
                                downloadId: download.id,
                              })
                            }
                          >
                            Retry
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ControlSection>

            <ControlSection
              title="Recent policy activity"
              description="Metadata-only decisions; page content is never logged here."
            >
              {controls.recentEvents.length === 0 ? (
                <EmptyState>No policy decisions for this tab yet.</EmptyState>
              ) : (
                <ol className="space-y-1.5">
                  {controls.recentEvents.slice(0, 8).map((event) => (
                    <li key={event.id} className="grid grid-cols-[7px_1fr_auto] items-center gap-2 text-copy-12">
                      <span
                        className={`size-1.5 rounded-full ${event.decision === "block" ? "bg-red-700" : event.decision === "ask" ? "bg-amber-700" : "bg-green-700"}`}
                      />
                      <span className="min-w-0 truncate text-gray-900">
                        <span className="font-medium capitalize">{event.capability}</span> · {event.reason}
                      </span>
                      <time className="font-mono text-[10px] text-gray-600">
                        {new Date(event.occurredAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </ControlSection>
          </div>
        </div>
      </div>
    </section>
  );
}

function ControlSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-gray-300 bg-background-100 p-4">
      <h2 className="text-label-14 font-semibold text-gray-1000">{title}</h2>
      <p className="mb-3 text-copy-12 text-gray-700">{description}</p>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-sm bg-gray-100 px-3 py-4 text-center text-copy-12 text-gray-700">{children}</p>;
}
