import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

/**
 * Geist Badge (vercel.com/geist/badge): a static pill label. Each hue has a
 * high-contrast fill and a `-subtle` tint; sizes are Geist's 20/24/32px.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 select-none items-center whitespace-nowrap rounded-full font-medium tabular-nums [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        gray: "bg-gray-700 text-white",
        "gray-subtle": "bg-gray-200 text-gray-1000",
        blue: "bg-blue-700 text-white",
        "blue-subtle": "bg-blue-100 text-blue-900",
        green: "bg-green-700 text-white",
        "green-subtle": "bg-green-100 text-green-900",
        amber: "bg-amber-700 text-black",
        "amber-subtle": "bg-amber-100 text-amber-900",
        red: "bg-red-700 text-white",
        "red-subtle": "bg-red-100 text-red-900",
        inverted: "bg-gray-1000 text-background-100",
      },
      size: {
        sm: "h-5 gap-1 px-1.5 text-[11px] leading-4 [&_svg]:size-3",
        md: "h-6 gap-1.5 px-2.5 text-label-12 [&_svg]:size-3.5",
        lg: "h-8 gap-1.5 px-3 text-label-14 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "gray-subtle", size: "md" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  icon?: React.ReactNode;
}

function Badge({ className, variant, size, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {icon}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
