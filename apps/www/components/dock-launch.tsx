import { WALLPAPER } from "./hero-browser/tour-protocol";

/** The mark from app/icon.svg, drawn into a 64×64 box. */
const MARK =
  "M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z";

/** The apps already in the dock: plain tiles with a simple glyph each, so Pistachio is the only colour. */
const NEIGHBOURS: Array<{ x: number; fill: string; glyph: React.ReactNode }> = [
  { x: 22, fill: "#e9e4d8", glyph: <circle cx="22" cy="22" r="9" fill="none" stroke="#b9b09a" strokeWidth="3" /> },
  { x: 76, fill: "#dfe7dc", glyph: <path d="M13 26h18M13 18h18" stroke="#9fb39a" strokeWidth="3" strokeLinecap="round" /> },
  { x: 184, fill: "#e4e1ea", glyph: <rect x="13" y="13" width="18" height="18" rx="4" fill="none" stroke="#aaa3b9" strokeWidth="3" /> },
  { x: 238, fill: "#e6e2dc", glyph: <path d="M14 29 22 14l8 15Z" fill="none" stroke="#b6aa98" strokeWidth="3" strokeLinejoin="round" /> },
];

/**
 * A little Mac desktop for the download card: a dock with a gap in the
 * middle, and Pistachio arriving in it — the download arrow drops in, the
 * icon pops into the gap, bounces the way a launching app does, and its
 * "open" dot lights. It loops (keyframes in app/globals.css, `dock-*`), and
 * holds on the settled frame for anyone who prefers reduced motion.
 */
export function DockLaunch() {
  return (
    <div
      aria-hidden="true"
      className="relative h-[132px] overflow-hidden rounded-lg bg-cover bg-center"
      style={{ backgroundImage: `url("${WALLPAPER.src}")` }}
    >
      <svg viewBox="0 0 304 132" className="absolute inset-0 size-full">
        {/* the dock */}
        <rect x="8" y="66" width="288" height="60" rx="16" fill="rgba(255,255,255,0.55)" stroke="rgba(255,255,255,0.8)" />
        {NEIGHBOURS.map(({ x, fill, glyph }) => (
          <g key={x} transform={`translate(${String(x)} 71)`}>
            <rect width="44" height="44" rx="11" fill={fill} />
            {glyph}
          </g>
        ))}

        {/* the download arrow, falling into the gap */}
        <g className="dock-arrow">
          <path d="M152 14v22m-9-9 9 9 9-9" fill="none" stroke="#1a1a1a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </g>

        {/* Pistachio, arriving */}
        <g transform="translate(130 71)">
          <g className="dock-icon">
            <rect width="44" height="44" rx="12" fill="#52a862" />
            <path d={MARK} fill="#fff" transform="translate(8.8 8.8) scale(0.22)" />
          </g>
        </g>
        <circle className="dock-dot" cx="152" cy="120" r="2" fill="#1a1a1a" />
      </svg>
    </div>
  );
}
