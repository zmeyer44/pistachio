import { cn } from "../lib/cn";
import type { StatusTone } from "../lib/run";

/** The console dot's colour per status tone (lib/run.ts). */
export const TONE_DOT: Record<StatusTone, string> = {
  idle: "bg-green-700",
  working: "bg-green-700",
  attention: "bg-amber-700",
  human: "bg-blue-700",
  stopped: "bg-red-700",
};

/** A status as one small dot — the thread list's whole status column. */
export function StatusDot({
  tone,
  className,
}: {
  tone: StatusTone;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        TONE_DOT[tone],
        tone === "working" && "animate-pulse",
        className,
      )}
    />
  );
}
