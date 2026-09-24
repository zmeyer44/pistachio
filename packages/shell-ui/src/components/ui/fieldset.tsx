import * as React from "react";
import { cn } from "../../lib/cn";

/**
 * Geist Fieldset (vercel.com/geist/fieldset): related controls grouped in a
 * bordered card, with an optional footer carrying the group's explanation on
 * the left and its actions on the right.
 *
 * The card is the section heading. A Geist fieldset says what it is inside
 * its own frame — which is why the settings page has no eyebrow labels
 * floating above the cards.
 */
const TYPES = {
  default: "shadow-border",
  error: "shadow-[0_0_0_1px_var(--color-red-400)]",
  warning: "shadow-[0_0_0_1px_var(--color-amber-400)]",
} as const;

export interface FieldsetProps extends React.HTMLAttributes<HTMLElement> {
  type?: keyof typeof TYPES;
}

function Fieldset({ className, type = "default", ...props }: FieldsetProps) {
  return <section className={cn("overflow-hidden rounded-md bg-background-100", TYPES[type], className)} {...props} />;
}

/** The card's body. `disabled` grays it out and takes it out of reach. */
function FieldsetContent({
  className,
  disabled = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { disabled?: boolean }) {
  return (
    <div
      inert={disabled ? true : undefined}
      className={cn("px-5 py-4 @max-md:px-4", disabled && "pointer-events-none opacity-50", className)}
      {...props}
    />
  );
}

function FieldsetTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-heading-16 text-gray-1000", className)} {...props} />;
}

function FieldsetSubtitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-1.5 text-copy-13 leading-5 text-gray-900", className)} {...props} />;
}

/**
 * The footer is the recessed strip: a status on the left, actions on the
 * right. `highlight` raises it to the gray fill for a footer that is asking
 * for something (an unsaved edit, a destructive confirm).
 */
function FieldsetFooter({
  className,
  highlight = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { highlight?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-h-13 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-alpha-400 px-5 py-2.5 @max-md:px-4",
        highlight ? "bg-gray-100" : "bg-background-200",
        className,
      )}
      {...props}
    />
  );
}

function FieldsetFooterStatus({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("min-w-0 text-label-12 leading-4.5 text-gray-900", className)} {...props} />;
}

function FieldsetFooterActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ml-auto flex shrink-0 items-center gap-2", className)} {...props} />;
}

export { Fieldset, FieldsetContent, FieldsetFooter, FieldsetFooterActions, FieldsetFooterStatus, FieldsetSubtitle, FieldsetTitle };
