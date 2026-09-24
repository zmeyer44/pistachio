import * as React from "react";
import { cn } from "../../lib/cn";

/**
 * Geist Note (vercel.com/geist/note): a tinted strip of prose that qualifies
 * what is around it. Not a control and not a toast — it stays on the page.
 */
const TYPES = {
  secondary: "bg-background-200 text-gray-900 shadow-border",
  success: "bg-green-100 text-green-900",
  error: "bg-red-100 text-red-1000",
  warning: "bg-amber-100 text-amber-1000",
  info: "bg-blue-100 text-blue-900",
} as const;

const SIZES = {
  sm: "gap-2 rounded-sm px-2.5 py-1.5 text-label-12 [&_svg]:size-3.5",
  md: "gap-2.5 rounded-md px-3.5 py-2.5 text-copy-13 [&_svg]:size-4",
} as const;

export interface NoteProps extends React.HTMLAttributes<HTMLDivElement> {
  type?: keyof typeof TYPES;
  size?: keyof typeof SIZES;
  /** Rendered in front of the text, in the note's own color. */
  label?: string;
  icon?: React.ReactNode;
  /** A control the note carries, pushed to its trailing edge. */
  action?: React.ReactNode;
}

function Note({ className, type = "secondary", size = "md", label, icon, action, children, ...props }: NoteProps) {
  return (
    <div
      className={cn(
        "flex [&>svg]:shrink-0",
        action === undefined ? "items-start [&>svg]:mt-px" : "items-center",
        TYPES[type],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {icon}
      <p className="min-w-0 leading-5">
        {label === undefined ? null : <strong className="font-medium">{label}: </strong>}
        {children}
      </p>
      {action === undefined ? null : <span className="ml-auto shrink-0 pl-2">{action}</span>}
    </div>
  );
}

export { Note };
