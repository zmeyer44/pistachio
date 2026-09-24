import * as React from "react";
import { cn } from "../../lib/cn";

/**
 * Geist Input (vercel.com/geist/input): a single-line field, optionally with
 * a label above it, an affix inside it, and one line of description — or of
 * error, which replaces the description and reddens the ring.
 *
 * Sizes follow Button's 24/32/40px so a field and the button beside it line
 * up. No width here on purpose: width belongs to the call site, and
 * `className` always lands on the visual field, whether that is the input
 * itself or the box holding it with its affixes.
 */
const SIZES = {
  xs: "h-6 rounded-xs text-label-12",
  sm: "h-8 rounded-sm text-label-13",
  md: "h-10 rounded-sm text-label-14",
} as const;

const PADDING = { xs: "px-2", sm: "px-2.5", md: "px-3" } as const;

const RING =
  "bg-background-100 text-gray-1000 shadow-border transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--color-gray-500)]";
const INVALID_RING = "shadow-[0_0_0_1px_var(--color-red-700)] hover:shadow-[0_0_0_1px_var(--color-red-700)]";

export interface InputProps extends Omit<React.ComponentPropsWithoutRef<"input">, "size" | "prefix"> {
  size?: keyof typeof SIZES;
  /** Title Case noun. Rendered above the field and wired to it. */
  label?: string;
  /** One line under the field. Replaced by `error` when there is one. */
  description?: React.ReactNode;
  /** A validation message. Validate on blur, not on every keystroke. */
  error?: string | null;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  /** Affixes sit on the recessed fill unless this is false. */
  affixStyling?: boolean;
  /** For the wrapper that appears when there is a label or a message. */
  containerClassName?: string;
  /** Text styling for the field itself when affixes put it inside a box. */
  inputClassName?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      containerClassName,
      inputClassName,
      size = "sm",
      label,
      description,
      error,
      prefix,
      suffix,
      affixStyling = true,
      id,
      ...props
    },
    ref,
  ) => {
    const generated = React.useId();
    const inputId = id ?? generated;
    const messageId = `${inputId}-message`;
    const invalid = error !== undefined && error !== null && error !== "";
    const message = invalid ? error : description;
    const described = message === undefined || message === null ? undefined : messageId;

    const shared = {
      ref,
      id: inputId,
      "aria-invalid": invalid || undefined,
      "aria-describedby": described,
      ...props,
    };

    const field =
      prefix === undefined && suffix === undefined ? (
        <input
          {...shared}
          className={cn(
            "min-w-0 outline-none placeholder:text-gray-700 disabled:bg-gray-100 disabled:text-gray-700 disabled:shadow-border",
            RING,
            SIZES[size],
            PADDING[size],
            invalid
              ? `${INVALID_RING} focus:shadow-[0_0_0_1px_var(--color-red-700),0_0_0_4px_var(--color-red-100)]`
              : "focus:shadow-[0_0_0_1px_var(--color-gray-1000),0_0_0_4px_var(--color-alpha-200)]",
            className,
            inputClassName,
          )}
        />
      ) : (
        <div
          className={cn(
            "flex min-w-0 items-stretch overflow-hidden has-[input:disabled]:bg-gray-100 has-[input:disabled]:text-gray-700",
            RING,
            SIZES[size],
            invalid
              ? `${INVALID_RING} focus-within:shadow-[0_0_0_1px_var(--color-red-700),0_0_0_4px_var(--color-red-100)]`
              : "focus-within:shadow-[0_0_0_1px_var(--color-gray-1000),0_0_0_4px_var(--color-alpha-200)]",
            className,
          )}
        >
          <Affix side="start" size={size} styled={affixStyling}>
            {prefix}
          </Affix>
          <input
            {...shared}
            className={cn(
              "min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-gray-700",
              PADDING[size],
              inputClassName,
            )}
          />
          <Affix side="end" size={size} styled={affixStyling}>
            {suffix}
          </Affix>
        </div>
      );

    if (label === undefined && described === undefined) return field;

    return (
      <div className={cn("flex min-w-0 flex-col gap-1.5", containerClassName)}>
        {label === undefined ? null : (
          <label htmlFor={inputId} className="text-label-13 text-gray-1000">
            {label}
          </label>
        )}
        {field}
        {described === undefined ? null : (
          <p id={messageId} className={cn("text-label-12 leading-4.5", invalid ? "text-red-900" : "text-gray-900")}>
            {message}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = "Input";

/** An affix reads as part of the frame, not as content: recessed and quiet. */
function Affix({
  children,
  side,
  size,
  styled,
}: {
  children: React.ReactNode;
  side: "start" | "end";
  size: keyof typeof SIZES;
  styled: boolean;
}) {
  if (children === undefined || children === null || children === false) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-gray-900 [&_svg]:size-4 [&_svg]:text-gray-700",
        PADDING[size],
        styled && "bg-background-200",
        styled && (side === "start" ? "border-r border-alpha-400" : "border-l border-alpha-400"),
      )}
    >
      {children}
    </span>
  );
}

export { Input };
