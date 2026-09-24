import { cn } from "../../lib/cn";

/**
 * Geist Slider (vercel.com/geist/slider): a label, a track that fills to the
 * value in the high-contrast gray, and the value read back in mono at the
 * end — so a number nobody can read off a handle is still legible.
 *
 * The fill is a gradient on the track, positioned from `--fill`, because a
 * range input has no element for "the part behind the thumb".
 */
export interface SliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Appended to the readout. */
  suffix?: string;
  disabled?: boolean;
  className?: string;
}

const TRACK =
  "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-gray-1000)_0,var(--color-gray-1000)_var(--fill),var(--color-gray-400)_var(--fill),var(--color-gray-400)_100%)]";

const THUMB =
  "[&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-background-100 [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--color-gray-500),0_1px_2px_oklch(0_0_0/0.2)] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-100 [&:active::-webkit-slider-thumb]:scale-110";

export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  suffix = "%",
  disabled = false,
  className,
}: SliderProps) {
  const fill = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <label className={cn("grid grid-cols-[84px_minmax(80px,1fr)_44px] items-center gap-3 py-1.5", className)}>
      <span className="truncate text-label-12 text-gray-900">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ "--fill": `${String(fill)}%` } as React.CSSProperties}
        className={cn(
          "h-3.5 w-full cursor-pointer appearance-none bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring",
          TRACK,
          THUMB,
        )}
      />
      <span className="text-right font-mono text-[10.5px] tabular-nums text-gray-700">
        {value}
        {suffix}
      </span>
    </label>
  );
}
