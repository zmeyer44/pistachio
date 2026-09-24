import * as React from "react";
import { cn } from "../../lib/cn";

/** Geist material: a surface with a 1px alpha border and 8px radius. */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("rounded-md bg-background-100 shadow-border", className)} {...props} />
));
Card.displayName = "Card";

export { Card };
