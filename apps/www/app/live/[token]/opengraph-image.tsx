import type { ReactNode } from "react";
import { ImageResponse } from "next/og";
import { HOST_COLOR, LIVE_COLORS } from "@pistachio/live-share";

import { GLYPHS, loadFace, size } from "../../../lib/og";
import { linkPreview, type LinkPreview } from "../../../lib/live/preview";

export { contentType, size } from "../../../lib/og";

export const alt = "A space shared live from Pistachio";

/**
 * The card a live share's link unfurls with (docs/live-share.md §7 Link
 * preview): the lobby, restated for a chat — whose share, the space's name,
 * and the lobby's little desk drawn large (`DeskGlyph` in _guest/screens.tsx)
 * with the host's pointer, a guest's and a stroke between them. The guest
 * page's dark scheme, its tokens flattened to hex as Satori needs (oklch from
 * `@pistachio/live-share/styles.css`), and its face, Geist.
 */
const GROUND = "#0f1012";
const WELL = "#08090c";
const CARD = "#1c1d20";
const TEXT = "#f2f3f5";
const TEXT_2 = "#b8babe";
const TEXT_3 = "#7e8084";
const HAIRLINE = "rgba(255, 255, 255, 0.085)";
const LINE = "rgba(255, 255, 255, 0.1)";
const LINE_STRONG = "rgba(242, 243, 245, 0.24)";
const LIVE = "#58cd78";
const PRIMARY = "#f6f7f8";
const PRIMARY_TEXT = "#101214";
/** The brand tile's green (`BrandMark`). */
const BRAND = "#52a862";
const GUEST_COLOR = LIVE_COLORS[1];

const PAD_X = 64;
const PAD_Y = 56;

/** The pointer every live surface draws (`ARROW_PATH` in _guest/screens.tsx). */
const ARROW_PATH = "M0.6 0.6 L0.6 16.9 L4.6 13.2 L7.4 19.6 L10.4 18.3 L7.7 12.0 L13.2 12.0 Z";
const MARK_PATH =
  "M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z";

/** Read at a fifth of its size in most chats, so the name runs as large as its length allows. */
function titleSize(title: string): number {
  const length = [...title].length;
  if (length <= 14) return 88;
  if (length <= 28) return 72;
  if (length <= 56) return 58;
  return 50;
}

/** A name on a pointer's tag, kept to a tag's length. */
function tag(name: string, max = 14): string {
  const chars = [...name.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preview = await linkPreview(token);
  const words = copyOf(preview);
  // Every Latin letter, for the card's own words, then whatever the share's bring (its name, its host's).
  const fonts = await loadFace("Geist", [400, 500, 600], `${GLYPHS}…${Object.values(words).join("")}${initialOf(preview) ?? ""}`);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: `${PAD_Y}px ${PAD_X}px`,
          backgroundColor: GROUND,
          backgroundImage: "radial-gradient(circle at 78% 52%, rgba(88, 205, 120, 0.11), rgba(88, 205, 120, 0) 46%)",
          fontFamily: "Geist",
          color: TEXT,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width={40} height={40} viewBox="0 0 64 64">
              <rect width={64} height={64} rx={18} fill={BRAND} />
              <path d={MARK_PATH} transform="translate(12.8 12.8) scale(0.32)" fill="white" />
            </svg>
            <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>Pistachio</span>
          </div>
          {preview.kind === "unknown" ? null : <StatusChip live={preview.kind === "live"} />}
        </div>

        <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 52 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              {preview.kind === "live" ? <LiveDot size={14} /> : null}
              <span
                style={{
                  fontSize: 30,
                  fontWeight: 500,
                  letterSpacing: "-0.015em",
                  color: TEXT_2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 520,
                }}
              >
                {words.eyebrow}
              </span>
            </div>
            <div
              style={{
                display: "block",
                lineClamp: 3,
                marginTop: 18,
                fontSize: titleSize(words.title),
                fontWeight: 600,
                lineHeight: 1.04,
                letterSpacing: "-0.04em",
                color: preview.kind === "ended" ? TEXT_2 : TEXT,
              }}
            >
              {words.title}
            </div>
            <div style={{ display: "flex", marginTop: 40 }}>
              {preview.kind === "ended" ? (
                <span style={{ fontSize: 26, color: TEXT_3, letterSpacing: "-0.01em" }}>{words.action}</span>
              ) : (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    height: 66,
                    padding: "0 30px",
                    borderRadius: 18,
                    backgroundColor: PRIMARY,
                    color: PRIMARY_TEXT,
                    fontSize: 27,
                    fontWeight: 600,
                    letterSpacing: "-0.015em",
                  }}
                >
                  <span>{words.action}</span>
                  <svg width={24} height={24} viewBox="0 0 20 20" fill="none">
                    <path d="M4 10h11M10.5 5.5 15 10l-4.5 4.5" stroke={PRIMARY_TEXT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              )}
            </div>
          </div>

          <Desk preview={preview} />
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: `1px solid ${HAIRLINE}`,
            paddingTop: 20,
            fontSize: 24,
            letterSpacing: "-0.01em",
            color: TEXT_3,
          }}
        >
          <span>{words.footer}</span>
          <span>{preview.kind === "ended" ? "pistachio.run" : "No download · No account"}</span>
        </div>
      </div>
    ),
    {
      ...size,
      ...(fonts === undefined ? {} : { fonts }),
      // Whether the share is live is the card's to say, so it is drawn again
      // rather than kept a year (next/og's default); unfurlers keep their own.
      headers: { "cache-control": "public, max-age=60, s-maxage=60" },
    },
  );
}

const FEATURES = "See its windows live, point, draw and talk";

function copyOf(preview: LinkPreview): { eyebrow: string; title: string; action: string; footer: string } {
  switch (preview.kind) {
    case "live":
      return { eyebrow: `${preview.host ?? "Someone"} is sharing`, title: preview.title, action: "Join in your browser", footer: FEATURES };
    case "ended":
      return {
        eyebrow: "This live share has ended",
        title: preview.title,
        action: `Ask ${preview.host ?? "whoever sent it"} for a new link`,
        footer: "Shared live from Pistachio",
      };
    case "unknown":
      return { eyebrow: "Live share", title: "A space shared live", action: "Open in your browser", footer: FEATURES };
  }
}

function LiveDot({ size: dot }: { size: number }) {
  return (
    <div
      style={{
        width: dot,
        height: dot,
        borderRadius: dot,
        backgroundColor: LIVE,
        boxShadow: `0 0 0 ${Math.round(dot / 2)}px rgba(88, 205, 120, 0.2)`,
      }}
    />
  );
}

function StatusChip({ live }: { live: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 48,
        padding: "0 20px",
        borderRadius: 48,
        backgroundColor: live ? "rgba(88, 205, 120, 0.12)" : "rgba(255, 255, 255, 0.06)",
        border: `1px solid ${live ? "rgba(88, 205, 120, 0.32)" : HAIRLINE}`,
        color: live ? LIVE : TEXT_3,
        fontSize: 23,
        fontWeight: 500,
        letterSpacing: "-0.01em",
      }}
    >
      {live ? <LiveDot size={11} /> : null}
      <span>{live ? "Live now" : "Ended"}</span>
    </div>
  );
}

/** Text lines on a window, as the glyph's `<i>`s: the first a heading, then body. */
function Lines({ widths }: { widths: readonly number[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      {widths.map((width, index) => (
        <div
          key={index}
          style={{ width: `${width}%`, height: 9, borderRadius: 5, backgroundColor: index === 0 ? LINE_STRONG : LINE }}
        />
      ))}
    </div>
  );
}

function Window({ left, top, width, height, children }: { left: number; top: number; width: number; height: number; children: ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 20,
        borderRadius: 14,
        backgroundColor: CARD,
        boxShadow: `0 0 0 1px ${HAIRLINE}, 0 22px 40px -18px rgba(0, 0, 0, 0.8)`,
      }}
    >
      {children}
    </div>
  );
}

function Pointer({ left, top, color, name }: { left: number; top: number; color: string; name: string | null }) {
  return (
    <div style={{ position: "absolute", left, top, display: "flex" }}>
      <svg width={34} height={44} viewBox="-1.5 -1.5 16 21">
        <path d={ARROW_PATH} fill={color} stroke="white" strokeWidth={1.6} strokeLinejoin="round" />
      </svg>
      {name === null ? null : (
        <div
          style={{
            position: "absolute",
            left: 26,
            top: 34,
            display: "flex",
            padding: "5px 12px",
            borderRadius: 9,
            backgroundColor: color,
            color: "white",
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
            boxShadow: "0 6px 14px -6px rgba(0, 0, 0, 0.7)",
          }}
        >
          {name}
        </div>
      )}
    </div>
  );
}

/**
 * The desk in the well. Live, it is busy: the host's pointer on the first
 * window, the reader's own ("You") beside the ring they drew, and the host's
 * face; ended, the windows dim and nobody is there; unknown, the windows
 * alone — nothing is claimed of a share nobody could look up.
 */
/** The host's face: the first letter of their name, as the faces show it with the camera off. */
function initialOf(preview: LinkPreview): string | null {
  return preview.kind === "live" && preview.host !== null ? ([...preview.host.trim()][0]?.toUpperCase() ?? null) : null;
}

function Desk({ preview }: { preview: LinkPreview }) {
  const live = preview.kind === "live";
  const host = live ? preview.host : null;
  const initial = initialOf(preview);
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        width: 470,
        height: 360,
        flexShrink: 0,
        borderRadius: 30,
        backgroundColor: WELL,
        boxShadow: "inset 3px 3px 10px rgba(0, 0, 0, 0.55), inset -2px -2px 6px rgba(255, 255, 255, 0.045), 0 0 0 1px rgba(255, 255, 255, 0.05)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, display: "flex", opacity: preview.kind === "ended" ? 0.38 : 1 }}>
        <Window left={26} top={28} width={232} height={176}>
          <Lines widths={[46, 88, 72]} />
          <div style={{ display: "flex", flex: 1, borderRadius: 8, backgroundColor: "rgba(62, 99, 221, 0.22)" }} />
        </Window>
        <Window left={284} top={40} width={160} height={118}>
          <Lines widths={[52, 90, 64]} />
        </Window>
        <Window left={140} top={186} width={262} height={148}>
          <Lines widths={[40, 86, 74, 58]} />
        </Window>
      </div>

      {live ? (
        <>
          {/* A guest's pen ring round the second window's heading. */}
          <svg style={{ position: "absolute", left: 270, top: 26 }} width={190} height={84} viewBox="0 0 190 84" fill="none">
            <path
              d="M24 46 C 18 22, 92 12, 150 22 C 186 29, 182 60, 132 68 C 84 76, 22 70, 20 48 C 19 38, 40 30, 58 28"
              stroke={GUEST_COLOR}
              strokeWidth={5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <Pointer left={168} top={92} color={HOST_COLOR} name={host === null ? null : tag(host)} />
          <Pointer left={372} top={86} color={GUEST_COLOR} name="You" />
          {initial === null ? null : (
            <div
              style={{
                position: "absolute",
                // Satori places by left and top alone: right and bottom land elsewhere.
                left: 470 - 22 - 74,
                top: 360 - 22 - 74,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 74,
                height: 74,
                borderRadius: 74,
                backgroundColor: HOST_COLOR,
                border: `4px solid ${WELL}`,
                boxShadow: `0 0 0 3px ${LIVE}`,
                color: "white",
                fontSize: 32,
                fontWeight: 600,
              }}
            >
              {initial}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
