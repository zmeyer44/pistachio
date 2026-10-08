/** The kind of playback represented by one sidebar media card. */
export type MediaPlaybackKind = "audio" | "video" | "live";

/**
 * Media state reported by the isolated preload in a human tab. Page-owned
 * strings are untrusted, so main normalizes this shape before publishing it.
 */
export interface TabMediaReport {
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  kind: MediaPlaybackKind;
  /** Whether the selected media element is a video that can extend the sidebar player. */
  hasVideo: boolean;
  playing: boolean;
  elementMuted: boolean;
  /** The selected element's own volume, 0 to 1, its mute aside: each player's own, whatever the system's or another page's. */
  volume: number;
  position: number;
  duration: number | null;
  playbackRate: number;
  seekable: boolean;
  canPrevious: boolean;
  canNext: boolean;
  canPictureInPicture: boolean;
  /** Playback speed can be changed: a file with a duration, not a live stream or a captured MediaStream. */
  canSetRate: boolean;
  /** The media is already presented outside the normal page (PiP/fullscreen). */
  presenting: boolean;
  /**
   * The element plays a live MediaStream (`srcObject`) rather than a file or
   * a stream URL: a call's remote audio, a camera tile, a canvas capture.
   */
  stream: boolean;
}

/** Main-owned media state exposed to the trusted shell renderer. */
export interface BrowserMediaInfo extends TabMediaReport {
  tabId: string;
  tabTitle: string;
  tabUrl: string;
  faviconUrl: string | null;
  /** Page-wide Chromium mute OR the selected element's own mute. */
  muted: boolean;
  audible: boolean;
  /** Wall-clock time corresponding to `position`, for local progress projection. */
  updatedAt: number;
  /** Changes only when playback becomes active, so the stack order stays stable. */
  lastActiveAt: number;
  /**
   * A "Read aloud" card whose source page is still open can light the words
   * on that page as they are spoken: "on" while it does, "off" while it
   * could. Null for every other card (and for a clip whose page has closed).
   */
  followText: "on" | "off" | null;
  /**
   * A call, not a player: a live MediaStream in a tab that was granted the
   * camera, microphone, or screen for its current document. Pausing a call's
   * audio would only deafen the person while they still seem present, so the
   * sidebar stack leaves these out rather than offering player controls.
   */
  call: boolean;
}

/**
 * One "Read aloud" job the shell shows as a toast above the media stack:
 * generating until the clip's tab opens, or failed until the message clears.
 */
export interface ReadAloudStatus {
  id: string;
  phase: "generating" | "failed";
  /** Title of the page the selection came from. */
  sourceTitle: string;
  /** Short lead of the selected text, for the toast. */
  excerpt: string;
  startedAt: number;
  /** Set when `phase` is "failed". */
  message: string | null;
}

/**
 * How a tab should present its playing video while the sidebar card shows it.
 * The page keeps the viewport it was laid out in (main scales that viewport
 * into the card), so the presented band is only the top slice of it that the
 * card's shape covers: `aspect` is that band's height as a fraction of the
 * viewport's width.
 */
export interface MediaPresentation {
  aspect: number;
}

export type MediaControl =
  | { type: "playPause" }
  /** Pause without toggling: main sends it to a video that yields to another. */
  | { type: "pause" }
  | { type: "previous" }
  | { type: "next" }
  | { type: "mute" }
  | { type: "pictureInPicture" }
  | { type: "dismiss" }
  | { type: "focus" }
  | { type: "seek"; position: number }
  | { type: "setRate"; rate: number }
  /** The page's player alone, 0 to 1 (its element's volume): above 0, it is heard again if it was muted. */
  | { type: "setVolume"; volume: number }
  /** A "Read aloud" card: light the spoken words on the page they came from, or stop. */
  | { type: "followText"; enabled: boolean };

/**
 * How loud a tab's media sounds right now, for the desk's rail (docs/desk.md,
 * "Now playing"): 0 (silent) to 1, measured by its page while main asks it
 * to (setMediaMeters). Null when the page cannot hear its own media — a
 * protected (DRM) or cross-origin stream — and the rail only suggests it.
 */
export interface MediaLevel {
  tabId: string;
  level: number | null;
}

export function isMediaLevelReport(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}

export const MIN_PLAYBACK_RATE = 0.25;
export const MAX_PLAYBACK_RATE = 2;

const KINDS = new Set<MediaPlaybackKind>(["audio", "video", "live"]);
const ARTWORK_PROTOCOLS = new Set(["http:", "https:", "data:", "pistachio:"]);

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return [...value.slice(0, max)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, max);
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : null;
}

function artworkUrl(value: unknown): string | null {
  const raw = boundedText(value, 8_192);
  if (raw === null || raw === "") return null;
  try {
    const parsed = new URL(raw);
    return ARTWORK_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Validate, bound, and copy a page-owned media report. */
export function normalizeTabMediaReport(value: unknown): TabMediaReport | null {
  if (typeof value !== "object" || value === null) return null;
  const report = value as Record<string, unknown>;
  const title = boundedText(report["title"], 300);
  const artist = boundedText(report["artist"], 200);
  const album = boundedText(report["album"], 200);
  const position = finiteNumber(report["position"], 0, 1_000_000_000);
  const playbackRate = finiteNumber(report["playbackRate"], 0.05, 16);
  const volume = finiteNumber(report["volume"], 0, 1);
  const duration = report["duration"] === null
    ? null
    : finiteNumber(report["duration"], 0, 1_000_000_000);
  if (
    title === null ||
    artist === null ||
    album === null ||
    position === null ||
    playbackRate === null ||
    volume === null ||
    duration === null && report["duration"] !== null ||
    !KINDS.has(report["kind"] as MediaPlaybackKind) ||
    typeof report["playing"] !== "boolean" ||
    typeof report["hasVideo"] !== "boolean" ||
    typeof report["elementMuted"] !== "boolean" ||
    typeof report["seekable"] !== "boolean" ||
    typeof report["canPrevious"] !== "boolean" ||
    typeof report["canNext"] !== "boolean" ||
    typeof report["canPictureInPicture"] !== "boolean" ||
    typeof report["canSetRate"] !== "boolean" ||
    typeof report["presenting"] !== "boolean" ||
    typeof report["stream"] !== "boolean"
  ) {
    return null;
  }
  return {
    title,
    artist,
    album,
    artworkUrl: artworkUrl(report["artworkUrl"]),
    kind: report["kind"] as MediaPlaybackKind,
    hasVideo: report["hasVideo"],
    playing: report["playing"],
    elementMuted: report["elementMuted"],
    volume,
    position: duration === null ? position : Math.min(position, duration),
    duration,
    playbackRate,
    seekable: report["seekable"],
    canPrevious: report["canPrevious"],
    canNext: report["canNext"],
    canPictureInPicture: report["canPictureInPicture"],
    canSetRate: report["canSetRate"],
    presenting: report["presenting"],
    stream: report["stream"],
  };
}

export function isMediaControl(value: unknown): value is MediaControl {
  if (typeof value !== "object" || value === null) return false;
  const control = value as Record<string, unknown>;
  if (control["type"] === "setRate") {
    return typeof control["rate"] === "number" &&
      Number.isFinite(control["rate"]) &&
      control["rate"] >= MIN_PLAYBACK_RATE &&
      control["rate"] <= MAX_PLAYBACK_RATE;
  }
  if (control["type"] === "followText") return typeof control["enabled"] === "boolean";
  if (control["type"] === "setVolume") {
    return typeof control["volume"] === "number" && Number.isFinite(control["volume"]) && control["volume"] >= 0 && control["volume"] <= 1;
  }
  if (control["type"] === "seek") {
    return typeof control["position"] === "number" &&
      Number.isFinite(control["position"]) &&
      control["position"] >= 0 &&
      control["position"] <= 1_000_000_000;
  }
  return (
    control["type"] === "playPause" ||
    control["type"] === "pause" ||
    control["type"] === "previous" ||
    control["type"] === "next" ||
    control["type"] === "mute" ||
    control["type"] === "pictureInPicture" ||
    control["type"] === "dismiss" ||
    control["type"] === "focus"
  );
}
