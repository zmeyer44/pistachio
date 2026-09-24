import { cn } from "../../lib/cn";

/**
 * The wizard's layout pieces: the step rail over the headline, and the
 * mock window the right-hand stage draws its content into: a white frame
 * with three dots that the step's controls live inside, so the grid of
 * apps reads as "this is your sidebar" rather than a form.
 */

/** "STEP 2 OF 4" and the segmented rail beside it. */
export function StepRail({ count, index }: { count: number; index: number }) {
  return (
    <div className="flex items-center gap-3.5" data-testid="onboarding-rail">
      <span className="text-[10.5px] font-semibold tracking-[0.16em] text-gray-700 uppercase">
        Step {index + 1} of {count}
      </span>
      <span className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: count }, (_, at) => (
          <span
            key={at}
            className={cn(
              "h-[3px] rounded-full transition-all duration-300",
              at === index ? "w-9 bg-(--theme-accent)" : at < index ? "w-6 bg-(--theme-accent) opacity-45" : "w-6 bg-alpha-300",
            )}
          />
        ))}
      </span>
    </div>
  );
}

/**
 * A window within the window. `bleed` anchors it to the stage's bottom-right
 * corner and lets it run off the edges for a grid that scrolls;
 * `center` floats it whole.
 */
export function MockWindow({
  children,
  placement = "center",
  className,
  testId,
}: {
  children: React.ReactNode;
  placement?: "center" | "bleed";
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "onboarding-stage flex flex-col overflow-hidden bg-background-100 shadow-modal",
        placement === "bleed"
          ? "absolute top-14 right-[-28px] bottom-[-28px] left-14 rounded-tl-[22px] rounded-bl-[22px]"
          : "relative w-full max-w-[560px] rounded-[22px]",
        className,
      )}
    >
      <div aria-hidden="true" className="flex h-11 shrink-0 items-center gap-2 px-4.5">
        <span className="size-3 rounded-full bg-alpha-200" />
        <span className="size-3 rounded-full bg-alpha-200" />
        <span className="size-3 rounded-full bg-alpha-200" />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** An inline error the stage shows under whatever failed. */
export function StageNotice({ tone = "warning", children }: { tone?: "warning" | "error" | "info"; children: React.ReactNode }) {
  return (
    <p
      role={tone === "info" ? "status" : "alert"}
      className={cn(
        "rounded-md px-3.5 py-2.5 text-copy-13 leading-snug",
        tone === "error" ? "bg-red-100 text-red-1000" : tone === "warning" ? "bg-amber-100 text-amber-1000" : "bg-blue-100 text-blue-900",
      )}
    >
      {children}
    </p>
  );
}
