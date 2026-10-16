import * as React from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * shadcn/ui's Trace (ui.shadcn.com/docs/components/base/trace, 2026-10) on
 * Base UI's Collapsible, in the shell's tokens: a list of lines for what an
 * agent did — its reasoning, its steps, what failed. Each line is an icon,
 * a title, and an optional description and status; a line in a
 * `TraceCollapsibleTrigger` opens to its detail, and lines nest, so a
 * summary opens to its steps and a step to its output.
 *
 * `TraceLine` is always the line: wrap it in the trigger (or a link, a
 * dialog's trigger) to make it do something. A running line's title
 * shimmers (shell.css, with `.agent-shimmer`); an error line is red, and
 * says so in its title too; a pending one is faded. The icon is hidden
 * from assistive tech, so the title is the line's name — a full sentence.
 */

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn(
        "flex w-full min-w-0 flex-col gap-1.5 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-sm *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-2 *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

export type TraceStatus = "running" | "error" | "pending";

function TraceLine({ className, status, ...props }: React.ComponentProps<"span"> & { status?: TraceStatus | undefined }) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-2 text-[13px] leading-5 text-gray-700 transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-gray-1000 data-[status=error]:text-red-900 data-[status=error]:in-[a:hover,button:hover]:text-red-900 data-[status=pending]:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 [[data-slot=trace-title]~&]:-ml-1",
        className,
      )}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-title" className={cn("min-w-0 truncate", className)} {...props} />;
}

function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-description" className={cn("shrink-0 text-gray-600 tabular-nums", className)} {...props} />;
}

/** An expandable line: closed unless `defaultOpen`, or controlled by `open` with `onOpenChange`. */
function TraceCollapsible({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible.Root>, "open"> &
  (
    | { open?: undefined }
    | {
        open: boolean;
        onOpenChange: NonNullable<React.ComponentProps<typeof Collapsible.Root>["onOpenChange"]>;
      }
  )) {
  return <Collapsible.Root data-slot="trace-collapsible" className={cn("flex w-full min-w-0 flex-col", className)} {...props} />;
}

/** The button that opens the line's detail: the line, then a chevron that turns down open. */
function TraceCollapsibleTrigger({ className, children, ...props }: React.ComponentProps<typeof Collapsible.Trigger>) {
  return (
    <Collapsible.Trigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "group/trace-collapsible-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm text-left text-gray-700 transition-colors outline-none hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring has-[[data-status=error]]:text-red-900",
        className,
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform duration-200 group-aria-expanded/trace-collapsible-trigger:rotate-90">
        <ChevronRight />
      </TraceIcon>
    </Collapsible.Trigger>
  );
}

/**
 * The line's detail, under it and threaded from its icon. Its height runs
 * open and shut (Base UI measures it); open, it is `auto`, so detail that
 * grows as it streams is never cut short. `keepMounted` keeps it while
 * shut, so lines nested in it keep their own open state.
 */
function TraceCollapsibleContent({ className, children, ...props }: React.ComponentProps<typeof Collapsible.Panel>) {
  return (
    <Collapsible.Panel
      data-slot="trace-collapsible-content"
      className="h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          "mt-1.5 mb-1 ml-[calc(--spacing(2)-0.5px)] min-w-0 border-l border-alpha-400 pr-1 pl-3.5 text-[13px] leading-5 wrap-break-word text-gray-700",
          className,
        )}
      >
        {children}
      </div>
    </Collapsible.Panel>
  );
}

export { Trace, TraceLine, TraceIcon, TraceTitle, TraceDescription, TraceCollapsible, TraceCollapsibleTrigger, TraceCollapsibleContent };
