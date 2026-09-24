import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * Geist Select on the native <select>: the OS popover is the one control no
 * component betters for a short list of fixed choices, so only the closed
 * face is styled — same ring and height as Input, a chevron on the right.
 * Values are typed through `items`, so a numeric setting round-trips as a
 * number rather than the string the DOM hands back.
 */
export interface SelectItem<T extends string | number> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string | number>
  extends Omit<React.ComponentPropsWithoutRef<"select">, "value" | "onChange" | "size"> {
  value: T;
  items: ReadonlyArray<SelectItem<T>>;
  onValueChange: (value: T) => void;
}

export function Select<T extends string | number>({
  value,
  items,
  onValueChange,
  className,
  ...props
}: SelectProps<T>) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select
        value={String(value)}
        onChange={(event) => {
          const next = items.find((item) => String(item.value) === event.target.value);
          if (next !== undefined) onValueChange(next.value);
        }}
        className="h-8 w-full cursor-pointer appearance-none rounded-sm bg-background-100 pr-8 pl-2.5 text-label-13 text-gray-1000 shadow-border outline-none transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--color-gray-500)] focus:shadow-[0_0_0_1px_var(--color-gray-1000),0_0_0_4px_var(--color-alpha-200)] disabled:bg-gray-100 disabled:text-gray-700"
        {...props}
      >
        {items.map((item) => (
          <option key={String(item.value)} value={String(item.value)}>
            {item.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-gray-700"
      />
    </span>
  );
}
