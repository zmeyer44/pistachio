import { ArrowRight, LogIn, Monitor, PanelTop } from "lucide-react";
import type { RunSummary } from "@pistachio/protocol";
import { agentTabId } from "@pistachio/shell-contracts/agent-glow";
import {
  CredentialCapture,
  type CredentialCaptureTransport,
} from "@pistachio/web-account/credential-capture";
import { ControlError } from "@pistachio/web-account/control";
import { nativeApi } from "../api";
import { useAppStore } from "../store";
import { isCloudRun } from "../lib/cloud";
import { Button } from "./ui/button";

const nativeCaptureTransport: CredentialCaptureTransport = {
  async load(captureId) {
    const result = await nativeApi()!.getCredentialCapture(captureId);
    if (!result.ok) throw new ControlError(result.status, result.code);
    return { capture: result.value };
  },
  async submit(captureId, sealedPayload) {
    const result = await nativeApi()!.submitCredentialCapture(
      captureId,
      sealedPayload,
    );
    if (!result.ok) throw new ControlError(result.status, result.code);
  },
};

export function TakeoverCard({ run }: { run: RunSummary }) {
  const takeover = run.pendingTakeover!;
  const releaseControl = useAppStore((state) => state.releaseControl);
  const openLiveView = useAppStore((state) => state.openLiveView);
  const liveViewUnavailable = useAppStore(
    (state) => state.unavailable["openLiveView"] ?? null,
  );
  const controlUrl = useAppStore((state) => state.account.controlUrl);
  const selectTab = useAppStore((state) => state.selectTab);
  // The page the agent wants the person in: the tab it last worked, which
  // it may have been working in the background. A button takes them there
  // when it is not on screen — the agent does not switch tabs for them.
  // Not checked against the snapshot's tabs: those are the active Space's
  // alone, and the page may be in another (selectTab switches to it).
  const pageTabId = takeover.kind === "credentials" ? null : agentTabId(run);
  const pageOffScreen = useAppStore(
    (state) => pageTabId !== null && !(state.snapshot?.visibleTabIds.includes(pageTabId) ?? false),
  );
  if (takeover.kind === "credentials") {
    return (
      <section
        data-testid="takeover-card"
        aria-label="Secure information requested"
        className="ml-8 min-w-0 overflow-hidden rounded-lg border border-blue-400 bg-background-100 shadow-small"
      >
        <CredentialCapture
          captureId={takeover.captureId}
          controlUrl={controlUrl || undefined}
          transport={nativeApi() === null ? undefined : nativeCaptureTransport}
          inline
        />
      </section>
    );
  }
  // A cloud run has no tab on this Mac (RunSummary.humanTabId is null): the
  // page it wants you in is on another machine, so "do it in the page" is
  // the one instruction that cannot be followed here.
  const elsewhere = run.humanTabId === null || isCloudRun(run);
  return (
    <section
      data-testid="takeover-card"
      className="ml-8 min-w-0 overflow-hidden rounded-lg border border-blue-400 bg-background-100 shadow-small"
    >
      <div className="flex items-start gap-2.5 bg-blue-100 px-3.5 py-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-700 text-white">
          <LogIn className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <span className="block text-[11px] font-medium tracking-wide text-blue-900 uppercase">
            Your turn in the browser
          </span>
          <strong className="mt-0.5 block text-heading-14 wrap-anywhere text-gray-1000">
            {takeover.reason}
          </strong>
        </div>
      </div>
      <div className="p-3.5">
        <p className="text-copy-13 wrap-anywhere text-gray-900">
          {takeover.instructions}
        </p>
        <p className="mt-2 text-[11px] leading-4 text-gray-700">
          {elsewhere
            ? "This run works in the cloud browser, so its page is not one of your tabs. Open the live view to do this there."
            : "Complete this directly in the page."}{" "}
          Don’t share passwords, verification codes, or payment details in chat.
        </p>
        {elsewhere || !pageOffScreen || pageTabId === null ? null : (
          <Button
            className="mt-3 w-full"
            variant="secondary"
            size="sm"
            data-testid="takeover-go-to-page"
            prefix={<PanelTop aria-hidden="true" />}
            onClick={() => void selectTab(pageTabId)}
          >
            Go to the page
          </Button>
        )}
        {!elsewhere ? null : liveViewUnavailable !== null ? (
          // The host has no overlay to raise, and says why. A button that
          // opens nothing is worse than the sentence that explains it.
          <p
            className="mt-3 text-[11px] leading-4 text-gray-700"
            data-testid="takeover-live-view-unavailable"
          >
            {liveViewUnavailable}
          </p>
        ) : (
          <Button
            className="mt-3 w-full"
            variant="secondary"
            size="sm"
            data-testid="takeover-live-view"
            prefix={<Monitor aria-hidden="true" />}
            onClick={() => void openLiveView(run.runId)}
          >
            Open the live view
          </Button>
        )}
        <Button
          className="mt-3 w-full"
          size="sm"
          data-testid="resume-after-takeover"
          suffix={<ArrowRight aria-hidden="true" />}
          onClick={() => void releaseControl()}
        >
          {takeover.resumeLabel}
        </Button>
      </div>
    </section>
  );
}
