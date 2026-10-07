import { cn } from "../../lib/cn";

export type StepState = "running" | "done" | "paused" | "failed";

const STATE_LABEL: Record<StepState, string> = {
  running: "Running",
  done: "Completed",
  paused: "Paused",
  failed: "Failed",
};

/**
 * A step's mark: a ring with a spinning arc while the step runs, and, when
 * it lands, a disc that pops in through a small blur as the ring fades and
 * then draws its glyph — a check, a cross for a failure, a pause while it
 * waits on the person (the spinner-to-check morph; styles in shell.css,
 * "A turn's steps"). Every glyph is in the DOM at once and the state picks
 * one, so a change of state is a transition: a mark that mounts settled is
 * drawn settled, and only a step seen running morphs.
 */
export function StepMark({ state, className }: { state: StepState; className?: string }) {
  return (
    <span className={cn("step-mark", className)} data-state={state} role="img" aria-label={STATE_LABEL[state]}>
      <span className="step-mark-ring" />
      <span className="step-mark-disc" />
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <g className="step-mark-glyph" data-glyph="done">
          <path d="M5.2 8.3 7.1 10.2 10.9 6.1" pathLength={1} />
        </g>
        <g className="step-mark-glyph" data-glyph="failed">
          <path d="M6 6 10 10" pathLength={1} />
          <path d="M10 6 6 10" pathLength={1} />
        </g>
        <g className="step-mark-glyph" data-glyph="paused">
          <path d="M6.6 5.9V10.1" pathLength={1} />
          <path d="M9.4 5.9V10.1" pathLength={1} />
        </g>
      </svg>
    </span>
  );
}
