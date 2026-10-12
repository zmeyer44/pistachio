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
  /**
   * The page's player alone, 0 to 1 (its element's volume): above 0, it is heard again if it was muted. At 0 with a
   * `restore` level, it is muted at that level instead, as its own mute would be: the player keeps what Unmute brings
   * back, whichever control (a card, the floating player) presses it.
   */
  | { type: "setVolume"; volume: number; restore?: number }
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

/** What `defaultRateVerdict` reads off a playing element. */
export interface DefaultRateCandidate {
  duration: number;
  /** It plays a MediaStream — a call, a capture — not a file. */
  stream: boolean;
  loop: boolean;
  muted: boolean;
  playbackRate: number;
}

/**
 * Whether media that has just started playing a new source takes the
 * default playback speed (Settings → General). The tab preload asks once per
 * source, on every site and in every frame:
 *
 *  - "wait" while its length is unknown; the next `playing` or
 *    `durationchange` asks again.
 *  - "skip" a stream, a live broadcast, or a muted loop (a page's moving
 *    backdrop, a GIF made video): a speed means nothing to them, or changes
 *    how the page looks rather than how fast it is heard.
 *  - "skip" media already at another speed: the page set one — a site
 *    remembering the speed chosen in its own player — and that choice stands.
 *  - "apply" otherwise.
 */
export function defaultRateVerdict(media: DefaultRateCandidate): "apply" | "skip" | "wait" {
  if (media.stream) return "skip";
  if (Number.isNaN(media.duration)) return "wait";
  if (!Number.isFinite(media.duration)) return "skip";
  if (media.loop && media.muted) return "skip";
  if (media.playbackRate !== 1) return "skip";
  return "apply";
}

/**
 * The page-world half of the default playback speed: media whose events the
 * document never carries. An element the page plays without putting it in
 * the document (`new Audio(url).play()`) has no window above it, and a media
 * event does not leave a shadow root, so the preload's window listeners hear
 * neither. This hands such an element to `report`, before its events reach
 * the element itself, so the preload can listen there:
 *
 *  - as the page calls `play()` on it (a Proxy of the built-in), wherever it is;
 *  - as it loads or starts in a shadow root, whatever started it — autoplay,
 *    the browser's own controls — heard at every shadow root the page
 *    attaches, open or closed (a Proxy of `attachShadow`).
 *
 * Media in the document's own tree is not reported: the window hears it.
 * Shadow roots the parser makes (declarative shadow DOM) are not attached
 * through `attachShadow`; their media is reported only when the page plays it.
 *
 * Run by `contextBridge.executeInMainWorld` from its source text, so it
 * reaches nothing outside itself. `report` failing never fails the page's
 * call, and a call the built-in refuses throws as it would.
 */
export function watchMediaPlays(report: (media: HTMLMediaElement) => void): void {
  const Media = globalThis.HTMLMediaElement;
  const Host = globalThis.Element;
  if (Media === undefined || Host === undefined) return;
  const connected = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected")?.get;
  const targetOf = Object.getOwnPropertyDescriptor(Event.prototype, "target")?.get;
  const rootOf = Node.prototype.getRootNode;
  const listen = EventTarget.prototype.addEventListener;
  const call = Reflect.apply;
  if (connected === undefined || targetOf === undefined) return;
  const told = new WeakSet<HTMLMediaElement>();
  const tell = (media: HTMLMediaElement): void => {
    if (told.has(media)) return;
    told.add(media);
    try {
      report(media);
    } catch {
      // The page's media is the page's; a watcher that failed changes nothing about it.
    }
  };

  /** Where the page finds `name`, a Proxy of the built-in, kept as writable and hidden as the method it replaces. */
  const wrap = (target: object, name: string, apply: (fn: (...args: never[]) => unknown, self: unknown, args: never[]) => unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor === undefined || typeof descriptor.value !== "function") return;
    const value = new Proxy(descriptor.value as (...args: never[]) => unknown, { apply });
    Object.defineProperty(target, name, { ...descriptor, value });
  };

  wrap(Media.prototype, "play", (fn, self, args) => {
    try {
      if (self instanceof Media && (!call(connected, self, []) || call(rootOf, self, []) !== document)) tell(self);
    } catch {
      // As above: the call is the page's.
    }
    return call(fn, self, args);
  });

  // Capture, at the root: the element's own listeners, added by `report`,
  // are still ahead of the event that told about it.
  const heard = (event: Event): void => {
    const media: unknown = call(targetOf, event, []);
    if (media instanceof Media) tell(media);
  };
  wrap(Host.prototype, "attachShadow", (fn, self, args) => {
    const root = call(fn, self, args);
    for (const name of ["loadstart", "playing", "durationchange"]) call(listen, root, [name, heard, true]);
    return root;
  });
}

/** A default speed main answered with, or null for anything else. */
export function defaultRateAnswer(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_PLAYBACK_RATE && value <= MAX_PLAYBACK_RATE
    ? value
    : null;
}

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
    const restore = control["restore"];
    return typeof control["volume"] === "number" &&
      Number.isFinite(control["volume"]) &&
      control["volume"] >= 0 &&
      control["volume"] <= 1 &&
      (restore === undefined ||
        (control["volume"] === 0 && typeof restore === "number" && Number.isFinite(restore) && restore > 0 && restore <= 1));
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
