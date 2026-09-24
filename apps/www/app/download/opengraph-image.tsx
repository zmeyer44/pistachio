import { ImageResponse } from "next/og";

import {
  FilledButton,
  Frame,
  GREEN,
  INK,
  PAPER,
  SAGE,
  TRACK,
  loadFonts,
  size,
  text,
} from "../../lib/og";
import { formatBytes, release } from "../../lib/release";

export { contentType, size } from "../../lib/og";

export const alt = `Download Pistachio ${release.version} for macOS`;

/** The facts grid from the page, plus the one the page states in prose. */
const FACTS = [
  { label: "Version", value: release.version },
  { label: "Released", value: release.publishedAt },
  { label: "Chip", value: release.arch },
  { label: "Size", value: formatBytes(release.bytes) },
  { label: "Signed", value: "Notarized by Apple" },
];

export default async function Image() {
  const fonts = await loadFonts();

  return new ImageResponse(
    (
      <Frame
        badge={`${release.channel} · ${release.version}`}
        footerLeft="Signed and notarized · Open source · Local by default"
        footerRight={<span style={text(15)}>github.com/zmeyer44/pistachio</span>}
        footerRule={TRACK}
      >
        {/* The section label that opens the page. */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: `1px solid ${GREEN}`,
            paddingTop: 10,
            marginTop: 26,
            ...text(15),
          }}
        >
          <span>Download</span>
          <span>Download</span>
        </div>

        {/* The page's two columns: headline and button, then the facts. */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            gap: 48,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              gap: 22,
            }}
          >
            <span
              style={{
                fontSize: 60,
                lineHeight: 1,
                letterSpacing: "-0.04em",
                color: GREEN,
              }}
            >
              Pistachio for macOS
            </span>

            <span
              style={{
                ...text(20, INK),
                whiteSpace: "normal",
                maxWidth: 560,
              }}
            >
              A browser with an agent that works inside the tabs you are
              already signed in to. Runs on your Mac, keeps your data there.
            </span>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                marginTop: 4,
              }}
            >
              <FilledButton>Download for Apple silicon</FilledButton>
              <span style={text(14, INK)}>
                {release.file} · {formatBytes(release.bytes)}
              </span>
            </div>
          </div>

          {factsGrid()}
        </div>
      </Frame>
    ),
    { ...size, fonts },
  );
}

/**
 * The page's `<dl>`: two columns of paper cells on a track-coloured ground,
 * with the ground showing through as hairlines. Satori has no CSS grid and
 * its `flex-wrap` is unreliable at exact half-widths, so the grid is laid
 * out as explicit rows of two equal cells.
 */
function factsGrid() {
  const rows: (typeof FACTS)[] = [];
  for (let i = 0; i < FACTS.length; i += 2) rows.push(FACTS.slice(i, i + 2));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        width: 460,
        flexShrink: 0,
        border: `1px solid ${TRACK}`,
        borderRadius: 8,
        backgroundColor: TRACK,
        overflow: "hidden",
      }}
    >
      {rows.map((row, index) => (
        <div key={index} style={{ display: "flex", gap: 1 }}>
          {row.map((fact) => (
            <div
              key={fact.label}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                flex: 1,
                padding: "14px 18px",
                backgroundColor: PAPER,
              }}
            >
              <span style={text(13, SAGE)}>{fact.label}</span>
              <span style={{ ...text(18), whiteSpace: "normal", lineHeight: 1.3 }}>
                {fact.value}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
