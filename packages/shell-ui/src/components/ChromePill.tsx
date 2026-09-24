import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ChromeOrientation } from "../chrome/manifest-renderers";
import { cn } from "../lib/cn";

/**
 * The one shape behind UpdatePill and SyncPill. In the strip it is the
 * familiar pill — icon and label side by side. In the sidebar footer it is
 * a circle the exact size of the Space avatar beside it (size-6), so the
 * footer reads as a row of equals; the label unrolls out of the circle on
 * hover or keyboard focus rather than taking footer width all the time.
 *
 * The label stays in the DOM while collapsed (max-width, not display), so
 * assistive tech and tests read the pill the same in both states.
 */
export function ChromePill({
  orientation,
  tone,
  icon,
  label,
  className,
  ...button
}: {
  orientation: ChromeOrientation;
  /** Background/foreground classes; the shape never picks its own colors. */
  tone: string;
  icon: ReactNode;
  label: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (orientation === "horizontal") {
    return (
      <button
        type="button"
        {...button}
        className={cn(
          "no-drag inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-label-12 whitespace-nowrap transition-colors",
          tone,
          className,
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      {...button}
      className={cn(
        "no-drag group inline-flex h-6 shrink-0 items-center rounded-full text-label-12 whitespace-nowrap transition-colors",
        tone,
        className,
      )}
    >
      <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center">
        {icon}
      </span>
      <span
        className={cn(
          "max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-200 ease-out",
          "group-hover:max-w-48 group-hover:opacity-100 group-focus-visible:max-w-48 group-focus-visible:opacity-100",
        )}
      >
        <span className="block pr-2.5">{label}</span>
      </span>
    </button>
  );
}
