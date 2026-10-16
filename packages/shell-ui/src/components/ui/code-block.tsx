import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * shadcn/ui's Code Block (ui.shadcn.com/docs/components/base/code-block,
 * 2026-10), the parts a trace uses, in the shell's tokens: monospace text
 * in a bordered box that scrolls rather than grows past its cap — a
 * step's output, an error. `destructive` is an error's; `sm` is the size
 * for output inside a Trace. Its actions (a copy button) sit over its
 * corner and show while the pointer or the keyboard is in it.
 */
const codeBlockVariants = cva(
  "group/code-block relative flex w-full min-w-0 flex-col overflow-hidden rounded-md text-[13px] has-[>[data-slot=code-block-content]:focus-visible]:ring-2 has-[>[data-slot=code-block-content]:focus-visible]:ring-ring data-[size=sm]:text-[12px]",
  {
    variants: {
      variant: {
        default: "border border-alpha-400 bg-background-200 text-gray-1000",
        destructive: "border border-red-400 bg-red-100/50 text-red-900",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function CodeBlock({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof codeBlockVariants> & { size?: "default" | "sm" }) {
  return <div data-slot="code-block" data-variant={variant} data-size={size} className={cn(codeBlockVariants({ variant }), className)} {...props} />;
}

function CodeBlockActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-actions"
      className={cn(
        "absolute end-1.5 top-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-focus-within/code-block:opacity-100 group-hover/code-block:opacity-100 pointer-coarse:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** How long the copy button shows its check before going back to the icon. */
const COPIED_MS = 2_000;

function CodeBlockCopyButton({ value, className, onClick, ...props }: React.ComponentProps<"button"> & { value: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
        className={cn(
          "grid size-6 cursor-pointer place-items-center rounded-sm bg-background-100 text-gray-700 shadow-border transition-colors hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5",
          className,
        )}
        onClick={(event) => {
          onClick?.(event);
          navigator.clipboard
            .writeText(value)
            .then(() => setCopied(true))
            .catch(() => {
              // The clipboard refused (no focus, no permission): nothing to show.
            });
        }}
        {...props}
      >
        {copied ? <Check className="text-green-900" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

/** The text itself: kept as written (`wrap` breaks long lines instead of scrolling across), a tab stop so the keyboard can scroll it. */
function CodeBlockContent({ className, children, wrap = false, ...props }: React.ComponentProps<"pre"> & { wrap?: boolean }) {
  return (
    <pre
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      dir="ltr"
      tabIndex={0}
      className={cn(
        "scroll-thin min-h-0 min-w-0 overflow-auto px-3 py-2.5 text-start font-mono leading-relaxed outline-none group-data-[size=sm]/code-block:px-2.5 group-data-[size=sm]/code-block:py-2 data-wrap:whitespace-pre-wrap data-wrap:wrap-anywhere",
        className,
      )}
      {...props}
    >
      <code data-slot="code-block-code" className="block min-w-max in-data-wrap:min-w-0">
        {children}
      </code>
    </pre>
  );
}

export { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockContent };
