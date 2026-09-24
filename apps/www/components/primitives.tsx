import type { CSSProperties, ReactNode } from "react";

/**
 * A brand mark. The source paints an SVG mask with a solid colour rather than
 * inlining the artwork, which keeps every logo a single flat swatch.
 */
export function BrandMark({
  name,
  label,
  width,
  height,
  className = "",
  style,
}: {
  name: string;
  /** Accessible name. Omit when visible text already names the mark. */
  label?: string;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const url = `url(/logos/${name}.svg)`;
  const a11y = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <span
      {...a11y}
      className={`brandmark ${className}`}
      style={{
        width,
        height,
        WebkitMaskImage: url,
        maskImage: url,
        ...style,
      }}
    />
  );
}

/**
 * The hairline + repeated label that opens every section.
 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full items-center justify-between pt-3 shadow-[inset_0_1px_0_0_var(--color-green)]">
      <p className="text-12">{children}</p>
      <p className="text-12">{children}</p>
    </div>
  );
}

/** Arrow used inside filled buttons. */
export function ArrowRight({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M4 10h11M10.5 5.5 15 10l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Small arrow used on inline "Case Study →" links. */
export function ArrowTiny({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M3.5 8h9M8.5 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Diagonal arrow shown in the corner of the stat cards. */
export function ArrowUpRight({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M8 16 16 8M9 8h7v7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
