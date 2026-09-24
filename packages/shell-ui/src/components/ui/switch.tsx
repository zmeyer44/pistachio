import { cn } from "../../lib/cn";

/**
 * Geist Switch (vercel.com/geist/switch): a 32×18 track that fills with the
 * high-contrast gray when on. The one on/off affordance in the settings page,
 * so a person learns a single shape for "this is enabled".
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[18px] w-8 shrink-0 rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-gray-1000" : "bg-gray-500",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.2)] transition-[left] duration-150",
          checked ? "left-[calc(100%-16px)]" : "left-0.5",
        )}
      />
    </button>
  );
}
