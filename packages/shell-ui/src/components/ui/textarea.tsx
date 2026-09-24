import * as React from "react";
import { cn } from "../../lib/cn";

/**
 * Geist Textarea: 1px alpha border, gray-500 on hover, blue ring when focused.
 *
 * `variant="bare"` drops the chrome for composers that draw their own frame
 * around the field and the buttons beside it — the border, ring, and padding
 * belong to that wrapper, so a nested set would double up.
 */
const VARIANTS = {
  default:
    "min-h-20 rounded-sm bg-background-100 px-3 py-2 shadow-border transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--color-gray-500)] focus:shadow-[0_0_0_1px_var(--color-gray-1000),0_0_0_4px_var(--color-alpha-200)] disabled:bg-gray-100",
  bare: "bg-transparent",
} as const;

export interface TextareaProps extends React.ComponentPropsWithoutRef<"textarea"> {
  variant?: keyof typeof VARIANTS;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex w-full resize-none text-copy-14 text-gray-1000 outline-none placeholder:text-gray-700 disabled:text-gray-700",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
