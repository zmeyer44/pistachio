import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * Geist Button (vercel.com/geist/button) in shadcn form. Variants are Geist's
 * five — default (inverted), secondary (bordered), tertiary (ghost), error and
 * warning — and the sizes are Geist's 32/40/48px plus a 24px `xs` for browser
 * chrome. `shape="circle"` and `svgOnly` cover icon buttons.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium outline-none transition-[background-color,color,border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:bg-gray-100 disabled:text-gray-700 disabled:shadow-border [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-gray-1000 text-background-100 hover:bg-gray-900",
        secondary: "bg-background-100 text-gray-1000 shadow-border hover:bg-gray-100",
        tertiary: "bg-transparent text-gray-1000 hover:bg-alpha-100",
        error: "bg-red-700 text-white hover:bg-red-900",
        warning: "bg-amber-700 text-black hover:bg-amber-900 hover:text-white",
      },
      size: {
        xs: "h-6 px-2 text-label-12 [&_svg]:size-3.5",
        sm: "h-8 px-3 text-label-14 [&_svg]:size-4",
        md: "h-10 px-4 text-label-14 [&_svg]:size-4",
        lg: "h-12 px-5 text-[16px] [&_svg]:size-5",
      },
      shape: {
        square: "",
        circle: "rounded-full",
      },
      svgOnly: {
        true: "px-0",
        false: "",
      },
    },
    compoundVariants: [
      { svgOnly: true, size: "xs", className: "w-6" },
      { svgOnly: true, size: "sm", className: "w-8" },
      { svgOnly: true, size: "md", className: "w-10" },
      { svgOnly: true, size: "lg", className: "w-12" },
    ],
    defaultVariants: { variant: "default", size: "sm", shape: "square", svgOnly: false },
  },
);

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "prefix">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
}

/**
 * What `asChild` hands to Radix's `Slot`.
 *
 * `Slot` merges the button's props onto exactly ONE element, so a button
 * that also draws a prefix and a suffix has to say which of the three that
 * element is. Handing it the bare list instead makes it throw — "Slot failed
 * to slot onto its children. Expected a single React element child or
 * `Slottable`." — and the throw lands in whatever error boundary is above,
 * which on the browser app is the one that replaces the whole shell.
 *
 * So the child the caller passed is wrapped in `Slottable`, which is the
 * marker `Slot` looks for, and the prefix and suffix stay OUTSIDE it: they
 * are ordinary children of the slotted element, drawn around it, and none of
 * the button's props are merged onto them.
 *
 * The keys are Fragments rather than clones because the prefix and the suffix
 * belong to the caller — an icon it may have keyed, or `undefined`; wrapping
 * is the only way to key a node you are not allowed to rewrite.
 *
 * Pure, and exported, so `test/button-slot.test.ts` can pin the structure
 * without a DOM.
 */
export function slotChildren(
  prefix: React.ReactNode,
  children: React.ReactNode,
  suffix: React.ReactNode,
): React.ReactNode[] {
  return [
    <React.Fragment key="prefix">{prefix}</React.Fragment>,
    <Slottable key="children">{children}</Slottable>,
    <React.Fragment key="suffix">{suffix}</React.Fragment>,
  ];
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, shape, svgOnly, asChild = false, loading = false, prefix, suffix, children, disabled, ...props },
    ref,
  ) => {
    const inactive = disabled === true || loading;
    const lead = loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : prefix;
    // Two returns rather than one `Comp`, because the two differ in more than
    // their tag: `disabled` and `type` are a form control's attributes, and a
    // slotted <a> is not one — it says it is inert the way a link can, with
    // aria-disabled. The variants' `disabled:` rules never reached an anchor
    // either way.
    return asChild ? (
      <Slot
        ref={ref}
        data-loading={loading ? "" : undefined}
        aria-busy={loading || undefined}
        aria-disabled={inactive ? true : undefined}
        className={cn(buttonVariants({ variant, size, shape, svgOnly }), className)}
        {...props}
      >
        {slotChildren(lead, children, suffix)}
      </Slot>
    ) : (
      <button
        ref={ref}
        type="button"
        data-loading={loading ? "" : undefined}
        aria-busy={loading || undefined}
        disabled={inactive}
        className={cn(buttonVariants({ variant, size, shape, svgOnly }), className)}
        {...props}
      >
        {lead}
        {children}
        {suffix}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
