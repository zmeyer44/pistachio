import { ArrowDown, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store";
import { PistachioMark } from "../PistachioMark";
import { Button } from "../ui/button";
import { armedStyle, useUpdatePrompt, type UpdatePromptPhase } from "./model";

/** The pill's blue: the dialog's way forward reads as the same thing as the pill. */
const BLUE = "bg-blue-700 text-white hover:bg-blue-900";
const COMES_BACK = "Your tabs and Spaces come back just as they are.";

/**
 * The update dialog over the page (`overlay: "update"`): a newer Pistachio,
 * offered until it is installed or put off. App.tsx raises it when main says
 * it is due; lib/update-prompt.ts says when.
 *
 * The app's own icon at the centre, the way a Mac app announces itself: one
 * narrow card, the choice stacked under it, and the download drawn as a
 * ring around the icon rather than a bar beside it.
 */
export function UpdatePrompt() {
  const model = useUpdatePrompt();
  const { phase } = model;
  const icon = useAppStore((s) => s.settings.appearance.desktopIcon);
  const chip =
    phase.kind === "offer"
      ? model.current === null
        ? phase.version
        : `${model.current} → ${phase.version}`
      : phase.kind === "downloading"
        ? `${phase.percent}%`
        : phase.kind === "ready" || phase.kind === "restarting"
          ? phase.version
          : null;
  const ring =
    phase.kind === "downloading" ? phase.percent : phase.kind === "restarting" || phase.kind === "ready" ? 100 : phase.kind === "checking" ? -1 : null;

  return (
    <div className="animate-backdrop-in absolute inset-0 z-30 grid place-items-center rounded-md bg-[oklch(0_0_0/0.28)] p-5" data-testid="update-prompt-backdrop">
      <div
        ref={model.dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-prompt-title"
        aria-describedby="update-prompt-body"
        data-testid="update-prompt"
        data-phase={phase.kind}
        tabIndex={-1}
        style={armedStyle(model.armed)}
        className="animate-overlay-in w-full max-w-[340px] rounded-xl bg-background-100 px-6 pt-7 pb-5 text-center text-gray-1000 shadow-modal outline-none"
      >
        <div className="relative mx-auto grid size-20 place-items-center">
          {ring === null ? null : <ProgressRing percent={ring} />}
          {/* An edge of its own: the white dock icon would vanish into the card. */}
          <div className={cn("overflow-hidden rounded-[19px] shadow-[0_0_0_1px_var(--color-alpha-400),0_6px_16px_oklch(0_0_0/0.1)]", phase.kind === "restarting" && "animate-pulse")}>
            <PistachioMark size={64} desktopIcon variant={icon} />
          </div>
          {phase.kind === "offer" || phase.kind === "error" ? (
            <span
              className={cn(
                "absolute right-0 bottom-0 grid size-6 place-items-center rounded-full shadow-[0_0_0_3px_var(--color-background-100)] [&_svg]:size-3.5",
                phase.kind === "error" ? "bg-amber-700 text-black" : "bg-blue-700 text-white",
              )}
              aria-hidden="true"
            >
              {phase.kind === "error" ? <TriangleAlert /> : <ArrowDown strokeWidth={2.5} />}
            </span>
          ) : null}
        </div>

        <h2 id="update-prompt-title" className="mt-4 text-heading-20">
          {title(phase)}
        </h2>
        {chip === null ? null : (
          <span className="mt-2 inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 font-mono text-label-12 text-gray-900 tabular-nums">{chip}</span>
        )}
        <p id="update-prompt-body" className="mt-3 text-copy-14 text-balance text-gray-900" aria-live="polite">
          {body(phase)}
        </p>

        {phase.kind === "restarting" ? (
          <div className="h-2" />
        ) : (
          <div className="mt-6 grid gap-2">
            {phase.kind === "offer" ? (
              <>
                <Button size="md" className={BLUE} onClick={model.updateNow} data-testid="update-prompt-update">
                  Update now
                </Button>
                <Button variant="secondary" size="md" onClick={model.remindTomorrow} data-testid="update-prompt-tomorrow">
                  Remind me tomorrow
                </Button>
              </>
            ) : phase.kind === "downloading" ? (
              <Button
                variant="secondary"
                size="md"
                title="The download keeps going. Restart from the sidebar when you’re ready."
                onClick={model.close}
              >
                Restart later
              </Button>
            ) : phase.kind === "ready" ? (
              <>
                <Button size="md" className={BLUE} onClick={model.restart}>
                  Restart now
                </Button>
                <Button variant="secondary" size="md" onClick={model.close}>
                  Later
                </Button>
              </>
            ) : phase.kind === "error" ? (
              <>
                <Button size="md" onClick={model.retry}>
                  Try again
                </Button>
                <Button variant="secondary" size="md" onClick={model.close}>
                  Close
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="md" onClick={model.close}>
                Close
              </Button>
            )}
          </div>
        )}
        {phase.kind === "offer" && phase.offersLater ? (
          <button
            type="button"
            title={`Stops these reminders for ${phase.version}. The Update button stays in the sidebar.`}
            onClick={model.later}
            data-testid="update-prompt-later"
            className="mt-3.5 cursor-pointer rounded-sm text-label-13 text-gray-900 underline-offset-4 transition-colors hover:text-gray-1000 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700"
          >
            I’ll update later
          </button>
        ) : null}
      </div>
    </div>
  );
}

function title(phase: UpdatePromptPhase): string {
  switch (phase.kind) {
    case "offer":
      return "Update available";
    case "downloading":
      return "Downloading update";
    case "restarting":
      return "Restarting…";
    case "ready":
      return "Ready to restart";
    case "checking":
      return "Checking for updates…";
    case "error":
      return "Pistachio couldn’t update";
  }
}

function body(phase: UpdatePromptPhase): string {
  switch (phase.kind) {
    case "offer":
      return `It downloads in the background, then Pistachio restarts. ${COMES_BACK}`;
    case "downloading":
      return `Pistachio restarts as soon as it’s in. ${COMES_BACK}`;
    case "restarting":
      return COMES_BACK;
    case "ready":
      return `Restart to finish. ${COMES_BACK}`;
    case "checking":
      return "Asking for the newest version.";
    case "error":
      return phase.message;
  }
}

/** A ring round the icon: the download's progress, full once it is in, spinning (-1) while unknown. */
function ProgressRing({ percent }: { percent: number }) {
  const r = 38;
  const length = 2 * Math.PI * r;
  const spinning = percent < 0;
  const shown = spinning ? 25 : percent;
  return (
    <svg viewBox="0 0 80 80" className={cn("absolute inset-0 size-20 -rotate-90", spinning && "animate-spin")} aria-hidden="true">
      <circle cx="40" cy="40" r={r} fill="none" stroke="var(--color-alpha-200)" strokeWidth="3" />
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        stroke="var(--color-blue-700)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - shown / 100)}
        className="transition-[stroke-dashoffset] duration-300 ease-out"
      />
    </svg>
  );
}
