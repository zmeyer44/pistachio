import { ImageResponse } from "next/og";

import {
  CREAM,
  FilledButton,
  Frame,
  GREEN,
  INK,
  SAGE,
  loadFonts,
  size,
  text,
} from "../lib/og";

export { contentType, size } from "../lib/og";

export const alt = "Pistachio — a browser built for tomorrow";

/** The nav's link row, minus the one that points here. */
const NAV = ["Agent", "Spaces", "Memory", "Privacy", "Open source"];

export default async function Image() {
  const fonts = await loadFonts();

  return new ImageResponse(
    (
      <Frame
        badge="Early preview for macOS"
        footerLeft="Open source · Local by default · Runs on your Mac"
        footerRight={NAV.map((item) => (
          <span key={item} style={text(15)}>
            {item}
          </span>
        ))}
      >
        {/* The hero, restated: headline and blurb on the left, the agent's
            side of a run on the right. */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            gap: 44,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              gap: 24,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                fontSize: 62,
                lineHeight: 1,
                letterSpacing: "-0.04em",
                color: GREEN,
              }}
            >
              <span>A browser built</span>
              <span>for tomorrow</span>
            </div>

            <span
              style={{
                ...text(20, INK),
                whiteSpace: "normal",
                maxWidth: 560,
              }}
            >
              Pistachio is a Mac browser with an agent built in. Ask for
              something in plain words and it gets it done.
            </span>

            <div style={{ display: "flex", marginTop: 4 }}>
              <FilledButton>Get early access</FilledButton>
            </div>
          </div>

          {runCard()}
        </div>
      </Frame>
    ),
    { ...size, fonts },
  );
}

/**
 * One run, told the way the hero's overlay chips tell it: what you asked and
 * what the agent did. It is the one green surface on the card and does the
 * same job the hero's video rail does on the page — the block that survives
 * a timeline thumbnail at a fifth of this size.
 */
function runCard() {
  const steps = [
    "Opened the top email",
    "Typed the reply",
    "Sent it and archived the thread",
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 372,
        flexShrink: 0,
        backgroundColor: GREEN,
        borderRadius: 10,
        padding: "26px 28px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          ...text(14, SAGE),
        }}
      >
        <span>You asked</span>
        <span>Gmail tab</span>
      </div>

      <span
        style={{
          ...text(22, CREAM),
          whiteSpace: "normal",
          lineHeight: 1.3,
          marginTop: 10,
        }}
      >
        “Reply to the top email saying I’ll be ten minutes late, then archive
        it.”
      </span>

      <div
        style={{
          height: 1,
          backgroundColor: "rgba(249, 244, 235, 0.2)",
          margin: "22px 0",
        }}
      />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          ...text(14, SAGE),
        }}
      >
        <span>Steps so far</span>
        <span>{steps.length} actions</span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 12,
        }}
      >
        {steps.map((step, index) => (
          <div
            key={step}
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <span
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 20,
                backgroundColor: CREAM,
                fontSize: 12,
                fontWeight: 500,
                lineHeight: 1,
                color: GREEN,
              }}
            >
              {String(index + 1).padStart(2, "0")}
            </span>
            <span style={text(15, CREAM)}>{step}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
