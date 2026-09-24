import type { CSSProperties } from "react";
import { brandGradient } from "@pistachio/shell-contracts/brand-colors";

/**
 * The active favorite's dress, shared by the sidebar's grid and the
 * onboarding step's: the brand's colours as a hairline gradient border,
 * and the same gradient as a faint wash inside. One colour draws a flat
 * ring; Figma's five run the corner. The border is painted with the
 * padding-box/border-box trick, so the tile keeps an opaque face and the
 * wash sits over it as its own layer (`BrandWash`).
 */
export function brandBorderStyle(colors: readonly string[]): CSSProperties {
  return {
    borderColor: "transparent",
    background: `linear-gradient(var(--color-background-100), var(--color-background-100)) padding-box, ${brandGradient(colors)} border-box`,
  };
}

export function BrandWash({ colors }: { colors: readonly string[] }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-[0.14]"
      style={{ background: brandGradient(colors) }}
    />
  );
}
