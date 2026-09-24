import type { DesktopIconStyle } from "@pistachio/shell-contracts/appearance";

/**
 * The brand mark: the hex nut on its rounded green square, the same drawing as
 * the welcome pages' favicon (main/welcome-pages.ts). `tone="muted"` draws
 * it in the surrounding text colour instead — the quiet corner mark of a
 * page whose subject is something else (the home page).
 */
export function PistachioMark({ size, tone = "brand", variant = "green", desktopIcon = false }: { size: 20 | 24 | 48; tone?: "brand" | "muted"; variant?: DesktopIconStyle; desktopIcon?: boolean }) {
  const muted = tone === "muted";
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none" aria-hidden="true" className="block shrink-0">
      <rect width="48" height="48" rx="14" fill={muted ? "currentColor" : variant === "white" ? "#fff" : "#52a862"} />
      <path
        d="M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z"
        transform={desktopIcon ? "translate(6 6) scale(0.3)" : "translate(9.6 9.6) scale(0.24)"}
        fill={muted ? "var(--color-background-200)" : variant === "white" ? "#52a862" : "#fff"}
      />
    </svg>
  );
}
