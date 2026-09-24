import type { CSSProperties, ReactNode } from "react";

/**
 * Shared pieces for the social cards (`app/opengraph-image.tsx` and
 * `app/download/opengraph-image.tsx`). Satori — the renderer behind
 * `next/og` — has no cascade, no `oklch()`, no CSS grid and no system fonts,
 * so the site's tokens are flattened here and every layout is flexbox.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The palette, copied out of `@theme` in `globals.css`. Keep these in step
 * with the tokens there.
 */
export const GREEN = "#004d26"; // --color-green: headlines, rules, buttons
export const INK = "#204d36"; // --color-ink: body copy
export const CREAM = "#f9f4eb"; // --color-cream: the page
export const PAPER = "#fbf9f4"; // --color-paper: cards and fields
export const TRACK = "#e2dccf"; // --color-track: card borders
export const SAGE = "#8bc7a9"; // --color-sage: muted labels

export const PAD = 56;

/**
 * Every character the cards can render. The faces are fetched as `text=`
 * subsets, so a glyph that is not in this string falls back to Satori's
 * default face — add to it before adding copy with new punctuation.
 */
const GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" +
  " .,'’“”—–·&/%:;()-+_@";

/**
 * Inter, fetched as TrueType — the one face the site uses, via
 * `next/font/google` in `layout.tsx`. Asking Google for the CSS without a
 * browser `User-Agent` (which is what Node sends) gets TrueType back rather
 * than woff2, which Satori cannot parse.
 */
async function googleFont(weight: number) {
  const url =
    `https://fonts.googleapis.com/css2?family=Inter:wght@${weight}` +
    `&text=${encodeURIComponent(GLYPHS)}`;

  const css = await fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${url} → ${response.status}`);
    return response.text();
  });

  const src = /src: url\((?<url>[^)]+)\) format\('(?:truetype|opentype)'\)/.exec(
    css,
  )?.groups?.url;
  if (!src) throw new Error(`no TrueType source for Inter ${weight}`);

  return fetch(src).then((response) => {
    if (!response.ok) throw new Error(`${src} → ${response.status}`);
    return response.arrayBuffer();
  });
}

/**
 * The three weights the cards use, or none. A social card is not worth
 * failing a build over, so a fetch that goes wrong drops to the font Satori
 * ships with rather than throwing — the layout holds either way.
 */
export async function loadFonts() {
  try {
    const [regular, medium, semibold] = await Promise.all([
      googleFont(400),
      googleFont(500),
      googleFont(600),
    ]);

    return [
      { name: "Inter", data: regular, weight: 400 as const },
      { name: "Inter", data: medium, weight: 500 as const },
      { name: "Inter", data: semibold, weight: 600 as const },
    ].map((font) => ({ ...font, style: "normal" as const }));
  } catch (error) {
    console.error("opengraph-image: falling back to the default face —", error);
    return undefined;
  }
}

/* ------------------------------ type styles ----------------------------- */

/**
 * The site's type ramp tracks at -2% up to 32px and -4% from 40px up. The
 * cards are read at a fifth of their size, so the small sizes here run a
 * touch larger than their on-page equivalents.
 */
export function text(fontSize: number, color = GREEN): CSSProperties {
  return {
    fontSize,
    lineHeight: 1.4,
    letterSpacing: fontSize >= 40 ? "-0.04em" : "-0.02em",
    color,
    whiteSpace: "nowrap",
  };
}

/* ------------------------------- pieces -------------------------------- */

/** The brand mark from `public/logos/pistachio-mark.svg`, painted green. */
export function Mark({ height = 30 }: { height?: number }) {
  return (
    <svg
      width={height}
      height={height}
      viewBox="0 0 120 120"
      fill="none"
    >
      <path
        d="M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z"
        fill={GREEN}
      />
    </svg>
  );
}

/** The arrow used inside filled buttons (`ArrowRight` in `primitives.tsx`). */
export function Arrow({ size = 18, color = CREAM }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path
        d="M4 10h11M10.5 5.5 15 10l-4.5 4.5"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The hero's badge: a hairline-ringed pill on cream. */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        ...text(15),
        lineHeight: 1,
        border: `1px solid ${GREEN}`,
        borderRadius: 40,
        padding: "9px 14px",
      }}
    >
      {children}
    </span>
  );
}

/** The site's filled button: green, cream text, 6px corners. */
export function FilledButton({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 52,
        padding: "0 24px",
        borderRadius: 6,
        backgroundColor: GREEN,
        ...text(18, CREAM),
        lineHeight: 1,
      }}
    >
      <span>{children}</span>
      <Arrow />
    </div>
  );
}

/**
 * The card's shell: cream page, Inter, the nav's mark and wordmark in the
 * top-left with a badge opposite, and a ruled footer. Everything between is
 * the caller's.
 */
export function Frame({
  badge,
  children,
  footerLeft,
  footerRight,
  footerRule = GREEN,
}: {
  badge: ReactNode;
  children: ReactNode;
  footerLeft: ReactNode;
  footerRight: ReactNode;
  /** The section label's hairline is green; the install-steps rule is track. */
  footerRule?: string;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: CREAM,
        padding: PAD,
        fontFamily: "Inter",
        color: GREEN,
      }}
    >
      {/* Top bar — the nav's mark and wordmark, and the standing caveat. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Mark height={32} />
          <span
            style={{
              fontSize: 24,
              lineHeight: 1,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: GREEN,
            }}
          >
            Pistachio
          </span>
        </div>
        <Pill>{badge}</Pill>
      </div>

      {children}

      {/* Bottom bar — the section label's hairline and small text. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${footerRule}`,
          paddingTop: 16,
        }}
      >
        <span style={text(15)}>{footerLeft}</span>
        <div style={{ display: "flex", gap: 24 }}>{footerRight}</div>
      </div>
    </div>
  );
}
