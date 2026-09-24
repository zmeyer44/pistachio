import { capturePageResume, restorePageResume, sanitizePageResume } from "@pistachio/shell-contracts/page-resume";
import { ipcRenderer } from "electron";
import type { GlanceIntentRequest, GlanceOpenRequest } from "@pistachio/shell-contracts/ipc";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  type MediaControl,
  type MediaPresentation,
  type TabMediaReport,
} from "@pistachio/shell-contracts/media";
import type { GuardedBrowserAction, TabDataPolicy, TabPasskeySupport } from "@pistachio/shell-contracts/browser-controls";
import {
  READ_ALOUD_FOLLOW_CHANNEL,
  matchSpeechWords,
  speechWords,
  timedWordAt,
  wordTimeline,
  type ReadAloudFollowMessage,
  type ReadAloudFollowScript,
  type ReadAloudFollowSync,
  type SpeechWord,
  type TimedWord,
} from "@pistachio/shell-contracts/read-aloud";
import { isAuthenticationNavigation } from "@pistachio/shell-contracts/auth-popup";
import { registrableHost } from "@pistachio/shell-contracts/browser-import";

// Keep this sandbox preload a single file. Importing the shared IPC object at
// runtime makes Rollup split it into a local chunk, while Electron's sandbox
// only permits `require("electron")` and a small set of built-ins.
const GLANCE_OPEN_CHANNEL = "pistachio:glance-open-request";
const GLANCE_INTENT_CHANNEL = "pistachio:glance-intent";
const GLANCE_DISMISS_CHANNEL = "pistachio:glance-dismiss-request";
const GLANCE_CONFIGURATION_CHANNEL = "pistachio:glance-configuration";
const MEDIA_REPORT_CHANNEL = "pistachio:media-report";
const MEDIA_COMMAND_CHANNEL = "pistachio:media-command";
const MEDIA_PRESENTATION_CHANNEL = "pistachio:media-presentation";
const MEDIA_PREVIEW_HOVER_REPORT_CHANNEL = "pistachio:media-preview-hover-report";
const DATA_POLICY_CHANNEL = "pistachio:tab-data-policy";
const POLICY_BLOCKED_CHANNEL = "pistachio:tab-policy-blocked";
const PASSKEY_SUPPORT_REPORT_CHANNEL = "pistachio:tab-passkey-support-report";

const DRAG_TOLERANCE = 4;
const GLANCE_PROTOCOLS = new Set(["http:", "https:", "pistachio:"]);

interface PressedLink {
  link: HTMLAnchorElement | HTMLAreaElement;
  x: number;
  y: number;
}

let pressed: PressedLink | null = null;
let dataPolicy: TabDataPolicy = { copy: "allow", paste: "allow" };
let automaticGlance = false;

async function reportPasskeySupport(): Promise<void> {
  const localDevelopmentOrigin =
    location.protocol === "http:" &&
    (location.hostname === "localhost" ||
      location.hostname.endsWith(".localhost") ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]");
  // Chromium deliberately applies a narrower origin policy to WebAuthn than
  // the generic secure-context flag (custom secure schemes are not enough).
  const webAuthnOriginAllowed = location.protocol === "https:" || localDevelopmentOrigin;
  const webAuthnAvailable =
    webAuthnOriginAllowed && isSecureContext && typeof PublicKeyCredential !== "undefined" && navigator.credentials !== undefined;
  const [platformAuthenticatorAvailable, conditionalMediationAvailable] = await Promise.all([
    webAuthnAvailable && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
      ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false)
      : false,
    webAuthnAvailable && typeof PublicKeyCredential.isConditionalMediationAvailable === "function"
      ? PublicKeyCredential.isConditionalMediationAvailable().catch(() => false)
      : false,
  ]);
  const report: TabPasskeySupport = {
    webAuthnAvailable,
    platformAuthenticatorAvailable,
    conditionalMediationAvailable,
  };
  ipcRenderer.send(PASSKEY_SUPPORT_REPORT_CHANNEL, report);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => void reportPasskeySupport(), { once: true });
} else {
  void reportPasskeySupport();
}

ipcRenderer.on(DATA_POLICY_CHANNEL, (_event, policy: TabDataPolicy) => {
  if ((policy.copy === "allow" || policy.copy === "block") && (policy.paste === "allow" || policy.paste === "block")) {
    dataPolicy = policy;
  }
});

ipcRenderer.on(GLANCE_CONFIGURATION_CHANNEL, (_event, configuration: unknown) => {
  automaticGlance =
    typeof configuration === "object" &&
    configuration !== null &&
    (configuration as Record<string, unknown>)["automatic"] === true;
});

function enforceDataEvent(event: ClipboardEvent, action: "copy" | "paste"): void {
  if (dataPolicy[action] !== "block") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send(POLICY_BLOCKED_CHANNEL, action satisfies GuardedBrowserAction);
}

window.addEventListener("copy", (event) => enforceDataEvent(event, "copy"), true);
window.addEventListener("cut", (event) => enforceDataEvent(event, "copy"), true);
window.addEventListener("paste", (event) => enforceDataEvent(event, "paste"), true);

function linkInPath(event: Event): HTMLAnchorElement | HTMLAreaElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLAnchorElement || target instanceof HTMLAreaElement) return target;
  }
  return null;
}

function sourceElement(event: MouseEvent, link: HTMLAnchorElement | HTMLAreaElement): Element {
  for (const target of event.composedPath()) {
    if (target instanceof Element && link.contains(target)) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return target;
    }
  }
  return link;
}

function glanceUrl(link: HTMLAnchorElement | HTMLAreaElement): string | null {
  if (link instanceof HTMLAnchorElement && link.hasAttribute("download")) return null;
  try {
    const url = new URL(link.href, document.baseURI);
    return GLANCE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function opensNewTab(link: HTMLAnchorElement | HTMLAreaElement): boolean {
  const explicit = link.target.trim();
  const target = explicit === "" ? document.querySelector("base[target]")?.getAttribute("target")?.trim() ?? "" : explicit;
  return target.toLowerCase() === "_blank";
}

/**
 * A link to another site: a different registrable domain from the page's, not
 * just another path or subdomain. On a kept page (pin, favorite) such a link
 * is treated like `target="_blank"` — the kept page stays where it is and
 * the other site opens as a Glance.
 */
function leavesSite(url: string): boolean {
  try {
    const target = new URL(url);
    const here = location.hostname;
    if (target.hostname === "" || here === "") return false;
    return registrableHost(target.hostname.toLowerCase()) !== registrableHost(here.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The box a Glance grows out of when there is no anchor to measure: the
 * innermost painted element under the pointer, or the click point itself.
 */
function intentSource(event: MouseEvent): GlanceIntentRequest["source"] {
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) continue;
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
    }
  }
  return { x: Math.round(event.clientX), y: Math.round(event.clientY), width: 1, height: 1 };
}

function sourceBounds(event: MouseEvent, link: HTMLAnchorElement | HTMLAreaElement): GlanceOpenRequest["source"] {
  const rect = sourceElement(event, link).getBoundingClientRect();
  return {
    x: Math.round(rect.width > 0 ? rect.x : event.clientX),
    y: Math.round(rect.height > 0 ? rect.y : event.clientY),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

// Capture before site scripts. Main tells this isolated preload whether its
// owner is pinned/favorited, but validates that state again before accepting
// an automatic Glance request.
window.addEventListener(
  "mousedown",
  (event) => {
    const link = linkInPath(event);
    pressed = event.button === 0 && link !== null ? { link, x: event.clientX, y: event.clientY } : null;
  },
  true,
);

// ── Media stack ────────────────────────────────────────────────────────────
// The page can shape its DOM and metadata, but it never receives Electron's
// API. This isolated preload observes playback and sends only a bounded data
// report for main to validate and associate with event.sender's real tab.

const PREVIOUS_SELECTOR = [
  "button[aria-label*='previous' i]",
  "button[title*='previous' i]",
  "[role='button'][aria-label*='previous' i]",
  "[data-testid*='skip-back' i]",
  ".ytp-prev-button",
].join(",");
const NEXT_SELECTOR = [
  "button[aria-label*='next' i]",
  "button[title*='next' i]",
  "[role='button'][aria-label*='next' i]",
  "[data-testid*='skip-forward' i]",
  ".ytp-next-button",
].join(",");

const engagedMedia = new Set<HTMLMediaElement>();
const activity = new WeakMap<HTMLMediaElement, number>();
let activityClock = 0;
let reportTimer: number | null = null;
let pollTimer: number | null = null;
let lastReportAt = 0;
/**
 * The last report main received, keyed without `position` (see
 * `reportKey`), plus its position and send time. `undefined` means nothing
 * has been sent for this document yet, so the first report — even "no
 * media" — always goes out; `null` means main was last told there is none.
 */
let lastSent: { key: string; position: number; at: number } | null | undefined;
/** Track-control lookups cost several document-wide attribute scans; keep them briefly. */
let controlsCache: { at: number; canPrevious: boolean; canNext: boolean } | null = null;
const CONTROLS_CACHE_MS = 2_000;
/** Below this, a report that differs only in position rides the 1 s poll instead. */
const POSITION_ONLY_RESEND_MS = 950;
let sidebarVideoEnabled = false;
let sidebarVideoTarget: HTMLVideoElement | null = null;
let sidebarVideoHovered = false;
/**
 * The sidebar card's shape, as its height over the viewport's width. Main
 * keeps the page's own viewport while the card shows it (the view is scaled,
 * not resized), so the card covers only a band across the top of that
 * viewport: this is the band the video has to fill, and `null` means the
 * card is presenting no video of this page.
 */
let sidebarVideoBand: number | null = null;
/** The band the standing presentation was built for, so a reshaped card rebuilds it. */
let sidebarVideoPresentedBand: number | null = null;

const MINI_VIDEO_ROOT = "data-pistachio-mini-video";
const MINI_VIDEO_TARGET = "data-pistachio-mini-video-target";
const MINI_VIDEO_ANCESTOR = "data-pistachio-mini-video-ancestor";
const MINI_VIDEO_STYLE_ID = "pistachio-mini-video-style";

function reportSidebarVideoHover(hovered: boolean): void {
  const next = sidebarVideoEnabled && hovered;
  if (sidebarVideoHovered === next) return;
  sidebarVideoHovered = next;
  ipcRenderer.send(MEDIA_PREVIEW_HOVER_REPORT_CHANNEL, next);
}

function mediaFromEvent(event: Event): HTMLMediaElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLMediaElement) return target;
  }
  return null;
}

function allMedia(): HTMLMediaElement[] {
  const found = new Set(document.querySelectorAll<HTMLMediaElement>("audio,video"));
  for (const media of engagedMedia) {
    if (media.isConnected) found.add(media);
    else engagedMedia.delete(media);
  }
  return [...found];
}

/**
 * The one element the tab reports. Playing beats paused, and among playing
 * elements one with its sound on beats a muted one: a call page plays its
 * remote audio beside muted camera tiles, a podcast page beside a looping
 * muted hero video. Every playing element fires `timeupdate` several times a
 * second, so without that rank the recency tie-break hands the pick back and
 * forth between them — and the sidebar card, which shows the audio but not a
 * muted video, would blink in and out every few seconds.
 *
 * The ranks are compared in order, not summed: `activity` is a counter that
 * only grows, and over a long call it would outweigh any fixed bonus.
 */
function mediaRank(media: HTMLMediaElement): number[] {
  const rect = media.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0;
  const playing = !media.paused && !media.ended;
  return [
    playing && !media.muted && media.volume > 0 ? 1 : 0,
    playing ? 1 : 0,
    document.pictureInPictureElement === media ? 1 : 0,
    activity.get(media) ?? 0,
    visible ? Math.min(rect.width * rect.height, 100_000) : 0,
  ];
}

function outranks(rank: readonly number[], other: readonly number[]): boolean {
  for (let index = 0; index < rank.length; index += 1) {
    if (rank[index] !== other[index]) return rank[index]! > other[index]!;
  }
  return false;
}

function primaryMedia(): HTMLMediaElement | null {
  const candidates = allMedia().filter((media) => engagedMedia.has(media) || !media.paused || media.currentTime > 0);
  let selected: HTMLMediaElement | null = null;
  let selectedRank: number[] = [];
  for (const media of candidates) {
    const rank = mediaRank(media);
    if (selected === null || outranks(rank, selectedRank)) {
      selected = media;
      selectedRank = rank;
    }
  }
  return selected;
}

/**
 * Turn the page's own selected video into the sidebar picture. The exact
 * element stays in its document and keeps its MediaSession, buffered data,
 * captions, and controls; only a temporary isolated stylesheet presents it
 * as the whole WebContentsView. Removing the attributes restores the page
 * without cloning or replacing the media node.
 */
function presentSidebarVideo(media: HTMLMediaElement | null): void {
  const next = sidebarVideoEnabled && media instanceof HTMLVideoElement ? media : null;
  const band = next === null ? null : sidebarVideoBand;
  if (next === sidebarVideoTarget && band === sidebarVideoPresentedBand && next?.isConnected === true) return;
  // Nothing presented and nothing to present — the ordinary case on every
  // page, reached once a second per playing video and on every mutation.
  // The root attribute is the sweep's own trace, so testing it keeps this a
  // fast path without giving up the cleanup: if presentation was somehow
  // left standing, the teardown below still runs and takes it down.
  const presented = document.documentElement?.hasAttribute(MINI_VIDEO_ROOT) === true;
  if (next === null && sidebarVideoTarget === null && !presented) return;

  sidebarVideoTarget?.removeAttribute(MINI_VIDEO_TARGET);
  for (const ancestor of document.querySelectorAll(`[${MINI_VIDEO_ANCESTOR}]`)) {
    ancestor.removeAttribute(MINI_VIDEO_ANCESTOR);
  }
  document.documentElement?.removeAttribute(MINI_VIDEO_ROOT);
  document.getElementById(MINI_VIDEO_STYLE_ID)?.remove();
  sidebarVideoTarget = null;
  sidebarVideoPresentedBand = null;

  if (next === null || band === null || document.documentElement === null) return;
  const style = document.createElement("style");
  style.id = MINI_VIDEO_STYLE_ID;
  style.textContent = `
    html[${MINI_VIDEO_ROOT}], html[${MINI_VIDEO_ROOT}] body {
      margin: 0 !important;
      overflow: hidden !important;
      background: #000 !important;
    }
    html[${MINI_VIDEO_ROOT}] body * { visibility: hidden !important; }
    html[${MINI_VIDEO_ROOT}] [${MINI_VIDEO_ANCESTOR}],
    html[${MINI_VIDEO_ROOT}] video[${MINI_VIDEO_TARGET}] {
      visibility: visible !important;
    }
    /* Any of these on an ancestor makes it the containing block of the
       video's position: fixed, pinning the picture to that box instead of
       the viewport. YouTube's miniplayer sets will-change: transform. */
    html[${MINI_VIDEO_ROOT}] [${MINI_VIDEO_ANCESTOR}] {
      overflow: visible !important;
      clip: auto !important;
      clip-path: none !important;
      contain: none !important;
      container-type: normal !important;
      content-visibility: visible !important;
      filter: none !important;
      backdrop-filter: none !important;
      mask: none !important;
      opacity: 1 !important;
      transform: none !important;
      translate: none !important;
      rotate: none !important;
      scale: none !important;
      perspective: none !important;
      will-change: auto !important;
    }
    html[${MINI_VIDEO_ROOT}] video[${MINI_VIDEO_TARGET}] {
      position: fixed !important;
      inset: 0 auto auto 0 !important;
      z-index: 2147483647 !important;
      display: block !important;
      width: 100vw !important;
      min-width: 0 !important;
      max-width: none !important;
      height: ${(band * 100).toFixed(4)}vw !important;
      min-height: 0 !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: #000 !important;
      object-fit: contain !important;
      opacity: 1 !important;
      transform: none !important;
    }
  `;
  document.documentElement.append(style);
  document.documentElement.setAttribute(MINI_VIDEO_ROOT, "");
  next.setAttribute(MINI_VIDEO_TARGET, "");
  for (let ancestor = next.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    ancestor.setAttribute(MINI_VIDEO_ANCESTOR, "");
  }
  sidebarVideoTarget = next;
  sidebarVideoPresentedBand = band;
}

function enabledControl(selector: string): HTMLElement | null {
  const control = document.querySelector<HTMLElement>(selector);
  if (control === null || control.getAttribute("aria-disabled") === "true") return null;
  if (control instanceof HTMLButtonElement && control.disabled) return null;
  return control;
}

/**
 * Whether previous/next controls are enabled, rescanned at most every couple
 * of seconds: `timeupdate` alone would otherwise walk the whole document
 * with ten substring selectors four times a second. A mutation that touches
 * media drops the cache (see `observeMediaTree`).
 */
function trackControls(): { canPrevious: boolean; canNext: boolean } {
  const now = performance.now();
  if (controlsCache === null || now - controlsCache.at >= CONTROLS_CACHE_MS) {
    controlsCache = {
      at: now,
      canPrevious: enabledControl(PREVIOUS_SELECTOR) !== null,
      canNext: enabledControl(NEXT_SELECTOR) !== null,
    };
  }
  return controlsCache;
}

function absoluteUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return null;
  }
}

function reportFor(media: HTMLMediaElement): TabMediaReport {
  const metadata = navigator.mediaSession?.metadata ?? null;
  const artwork = metadata?.artwork === undefined ? [] : [...metadata.artwork];
  const duration = Number.isFinite(media.duration) && media.duration >= 0 ? media.duration : null;
  const video = media instanceof HTMLVideoElement;
  const canPictureInPicture = video && document.pictureInPictureEnabled && !media.disablePictureInPicture;
  const controls = trackControls();
  return {
    title: metadata?.title?.trim() || document.title.trim() || "Media",
    artist: metadata?.artist?.trim() ?? "",
    album: metadata?.album?.trim() ?? "",
    artworkUrl: absoluteUrl(artwork.at(-1)?.src),
    kind: duration === null ? "live" : video ? "video" : "audio",
    hasVideo: video,
    playing: !media.paused && !media.ended,
    elementMuted: media.muted || media.volume === 0,
    position: Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0,
    duration,
    playbackRate: Number.isFinite(media.playbackRate) && media.playbackRate > 0 ? media.playbackRate : 1,
    seekable: duration !== null && (media.seekable.length > 0 || media.readyState >= HTMLMediaElement.HAVE_METADATA),
    canPrevious: controls.canPrevious,
    canNext: controls.canNext,
    canPictureInPicture,
    canSetRate: duration !== null && media.srcObject === null,
    presenting: document.pictureInPictureElement === media || document.fullscreenElement === media || document.fullscreenElement?.contains(media) === true,
    stream: media.srcObject instanceof MediaStream,
  };
}

function syncPoll(media: HTMLMediaElement | null): void {
  const shouldPoll = media !== null && !media.paused && !media.ended;
  if (shouldPoll && pollTimer === null) {
    pollTimer = window.setInterval(() => scheduleMediaReport(true), 1_000);
  } else if (!shouldPoll && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Every field of a report except `position`, which main projects from its own clock. */
function reportKey(report: TabMediaReport): string {
  const rest: Partial<TabMediaReport> = { ...report };
  delete rest.position;
  return JSON.stringify(rest);
}

function sendMediaReport(): void {
  reportTimer = null;
  const now = performance.now();
  lastReportAt = now;
  const media = primaryMedia();
  presentSidebarVideo(media);
  syncPoll(media);
  if (media === null) {
    // Main already knows there is nothing here; the common page never plays.
    if (lastSent === null) return;
    lastSent = null;
    ipcRenderer.send(MEDIA_REPORT_CHANNEL, null);
    return;
  }
  const report = reportFor(media);
  const key = reportKey(report);
  if (lastSent !== null && lastSent !== undefined && lastSent.key === key) {
    // Nothing but the clock moved. Paused, a moved clock is a seek and must
    // go out; playing, main projects the position from the last report and
    // the 1 s poll corrects any drift, so the 250 ms `timeupdate` cadence
    // adds nothing.
    if (lastSent.position === report.position) return;
    if (report.playing && now - lastSent.at < POSITION_ONLY_RESEND_MS) return;
  }
  lastSent = { key, position: report.position, at: now };
  ipcRenderer.send(MEDIA_REPORT_CHANNEL, report);
}

function scheduleMediaReport(immediate = false): void {
  if (reportTimer !== null) window.clearTimeout(reportTimer);
  const sinceLast = performance.now() - lastReportAt;
  const delay = immediate ? 0 : Math.max(0, 250 - sinceLast);
  reportTimer = window.setTimeout(sendMediaReport, delay);
}

const mediaEvents = [
  "play",
  "playing",
  "pause",
  "ended",
  "timeupdate",
  "durationchange",
  "loadedmetadata",
  "volumechange",
  "emptied",
  "ratechange",
  "enterpictureinpicture",
  "leavepictureinpicture",
  "fullscreenchange",
] as const;

for (const name of mediaEvents) {
  window.addEventListener(
    name,
    (event) => {
      const media = mediaFromEvent(event);
      if (media !== null) {
        if (name === "play" || name === "playing" || name === "timeupdate") engagedMedia.add(media);
        activity.set(media, ++activityClock);
      }
      scheduleMediaReport(name !== "timeupdate");
    },
    true,
  );
}

function isOrContainsMedia(node: Node): boolean {
  return (
    node instanceof HTMLMediaElement ||
    (node instanceof Element && node.querySelector("audio,video") !== null)
  );
}

function touchesMedia(records: MutationRecord[]): boolean {
  for (const record of records) {
    for (const node of record.addedNodes) if (isOrContainsMedia(node)) return true;
    for (const node of record.removedNodes) if (isOrContainsMedia(node)) return true;
  }
  return false;
}

function observeMediaTree(): void {
  // Every page mutates constantly; only a mutation that adds or removes media
  // can change the answer on a page without any. Once media is engaged or
  // reported, any mutation may have moved its controls or the element itself,
  // so the controls cache is dropped and a report scheduled — the cache only
  // ever spares the `timeupdate` reports between mutations. Paused media has
  // no poll, so a control appearing or being enabled is caught here or not
  // at all: the enablement attributes are observed alongside the tree.
  new MutationObserver((records) => {
    const mediaKnown = engagedMedia.size > 0 || (lastSent !== null && lastSent !== undefined);
    if (!mediaKnown && !touchesMedia(records)) return;
    controlsCache = null;
    scheduleMediaReport();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled"],
  });
  scheduleMediaReport(true);
}

if (document.documentElement === null) {
  window.addEventListener("DOMContentLoaded", observeMediaTree, { once: true });
} else {
  observeMediaTree();
}

async function runMediaCommand(control: MediaControl): Promise<void> {
  const media = primaryMedia();
  if (media === null) return;
  if (control.type === "playPause") {
    if (media.paused || media.ended) await media.play();
    else media.pause();
  } else if (control.type === "pause") {
    media.pause();
  } else if (control.type === "seek" && Number.isFinite(control.position)) {
    const upper = Number.isFinite(media.duration) ? media.duration : control.position;
    media.currentTime = Math.min(upper, Math.max(0, control.position));
  } else if (control.type === "previous") {
    enabledControl(PREVIOUS_SELECTOR)?.click();
  } else if (control.type === "next") {
    enabledControl(NEXT_SELECTOR)?.click();
  } else if (control.type === "setRate" && Number.isFinite(control.rate)) {
    const rate = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, control.rate));
    // Both, so a site that resets to the default on the next track keeps the choice.
    media.defaultPlaybackRate = rate;
    media.playbackRate = rate;
  } else if (control.type === "mute") {
    media.muted = !media.muted;
  } else if (control.type === "dismiss") {
    media.pause();
  }
  scheduleMediaReport(true);
}

ipcRenderer.on(MEDIA_COMMAND_CHANNEL, (_event, control: MediaControl) => {
  void runMediaCommand(control).catch(() => scheduleMediaReport(true));
});

ipcRenderer.on(MEDIA_PRESENTATION_CHANNEL, (_event, presentation: unknown) => {
  const aspect =
    typeof presentation === "object" && presentation !== null
      ? (presentation as Partial<MediaPresentation>).aspect
      : undefined;
  sidebarVideoBand =
    typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0 && aspect <= 100 ? aspect : null;
  sidebarVideoEnabled = sidebarVideoBand !== null;
  if (!sidebarVideoEnabled) reportSidebarVideoHover(false);
  syncSidebarVideoHoverListeners();
  presentSidebarVideo(primaryMedia());
  scheduleMediaReport(true);
});

// The sidebar video is a native WebContentsView above the shell, so its
// pointer never reaches the React card underneath. Relay only its boundary
// state; main validates that this sender owns the current media preview.
// The capture-phase listeners exist only for that card, so they are on the
// window only while this page is presented in it.
const onSidebarVideoPointerOver = (): void => reportSidebarVideoHover(true);
const onSidebarVideoPointerOut = (event: PointerEvent): void => {
  if (event.relatedTarget === null) reportSidebarVideoHover(false);
};
let sidebarVideoHoverListening = false;

function syncSidebarVideoHoverListeners(): void {
  if (sidebarVideoHoverListening === sidebarVideoEnabled) return;
  sidebarVideoHoverListening = sidebarVideoEnabled;
  if (sidebarVideoEnabled) {
    window.addEventListener("pointerover", onSidebarVideoPointerOver, true);
    window.addEventListener("pointerout", onSidebarVideoPointerOut, true);
  } else {
    window.removeEventListener("pointerover", onSidebarVideoPointerOver, true);
    window.removeEventListener("pointerout", onSidebarVideoPointerOut, true);
  }
}

window.addEventListener(
  "click",
  (event) => {
    const start = pressed;
    pressed = null;
    const cleanModifiers = !event.ctrlKey && !event.metaKey && !event.shiftKey;
    // A modifier click the anchor path below cannot claim — a button that
    // navigates from script — still declares its intent, so main can Glance
    // the window.open that follows instead of spawning a tab. Only real
    // input qualifies: a synthetic click must not let the page dress its own
    // popups up as Glances.
    const declareIntent = () => {
      if (event.isTrusted && event.altKey && event.button === 0 && cleanModifiers)
        ipcRenderer.send(GLANCE_INTENT_CHANNEL, { source: intentSource(event) } satisfies GlanceIntentRequest);
    };
    if (start === null) {
      declareIntent();
      return;
    }
    if (
      event.button !== 0 ||
      !cleanModifiers ||
      Math.abs(event.clientX - start.x) > DRAG_TOLERANCE ||
      Math.abs(event.clientY - start.y) > DRAG_TOLERANCE
    ) {
      return;
    }
    const link = linkInPath(event);
    if (link === null || link !== start.link) {
      declareIntent();
      return;
    }
    const url = glanceUrl(link);
    if (url === null) {
      // javascript: and other unglanceable hrefs often window.open instead.
      declareIntent();
      return;
    }
    // From a kept page, a link that would open a tab — or leave for another
    // site — Glances instead, so the kept page never navigates away.
    const automatic = !event.altKey && automaticGlance && (opensNewTab(link) || leavesSite(url));
    if (!event.altKey && !automatic) return;
    // Identity links must retain Chromium's real child-window relationship.
    // Replacing sign-in or sign-out with an unrelated Glance breaks the session
    // handoff and leaves the already-open relying-party document stale.
    if (isAuthenticationNavigation(url)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const request: GlanceOpenRequest = {
      url,
      source: sourceBounds(event, link),
      automatic,
    };
    ipcRenderer.send(GLANCE_OPEN_CHANNEL, request);
  },
  true,
);

window.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    ipcRenderer.send(GLANCE_DISMISS_CHANNEL, document.activeElement !== null && document.activeElement !== document.body);
  },
  true,
);

// Coalesce page interaction; no screenshot, DOM clone, or remote page execution.
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
const reportResume = (): void => {
  if (resumeTimer !== undefined) clearTimeout(resumeTimer);
  resumeTimer = undefined;
  if (window.top === window && /^https?:$/u.test(location.protocol))
    ipcRenderer.send("pistachio:page-resume", capturePageResume());
};
const queueResume = (): void => {
  if (resumeTimer === undefined) resumeTimer = setTimeout(reportResume, 600);
};
window.addEventListener("scroll", queueResume, { passive: true });
window.addEventListener("input", queueResume, { passive: true });
window.addEventListener("pagehide", reportResume);
window.addEventListener("DOMContentLoaded", queueResume, { once: true });
ipcRenderer.on("pistachio:restore-page-resume", (_event, value: unknown) => {
  const state = sanitizePageResume(value, location.href);
  if (state) requestAnimationFrame(() => restorePageResume(state));
});

// ── Read aloud: following the text ─────────────────────────────────────────
// Main sends the clip's text, how far its voice has been measured, and where
// the player is (@pistachio/shell-contracts/read-aloud). This lights the word
// being spoken and its paragraph through the CSS Custom Highlight API — no
// node is added or changed, so the page's own scripts and styles are left
// alone — and keeps the word in view unless the person has just scrolled.

const FOLLOW_WORD_HIGHLIGHT = "pistachio-read-aloud-word";
const FOLLOW_PARAGRAPH_HIGHLIGHT = "pistachio-read-aloud-paragraph";
/** How often the lit word is recomputed while the clip plays. */
const FOLLOW_TICK_MS = 80;
/** After the person scrolls, the page is theirs for this long. */
const FOLLOW_SCROLL_GRACE_MS = 4_000;
/** Scrolls to the lit word are at least this far apart. */
const FOLLOW_SCROLL_GAP_MS = 800;
/** Below this share of matched words, the page is read again later — it may still be rendering. */
const FOLLOW_REMATCH_BELOW = 0.5;
const FOLLOW_REMATCH_EVERY_MS = 2_000;
const FOLLOW_REMATCH_ATTEMPTS = 6;
/** More tokens than this and the rest of the page is left unlit. */
const FOLLOW_MAX_PAGE_TOKENS = 250_000;

const FOLLOW_SKIPPED_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "TEXTAREA", "SELECT", "OPTION", "IFRAME", "OBJECT", "CANVAS",
]);
const FOLLOW_BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CAPTION", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT", "FIELDSET",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI", "MAIN",
  "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

interface FollowPage {
  /** Text nodes in order, with their spans in the joined text. */
  nodes: Array<{ node: Text; start: number; end: number }>;
  /** Whitespace-separated runs of the joined text. */
  tokens: Array<{ start: number; end: number }>;
  /** What the clip's words were matched against, as text. */
  tokenText: string[];
}

interface FollowState {
  script: ReadAloudFollowScript;
  sync: ReadAloudFollowSync | null;
  words: SpeechWord[];
  timeline: TimedWord[];
  page: FollowPage | null;
  /** Clip word → page token, or -1. */
  matched: Int32Array | null;
  /** Share of words with a token; low means the page may not have rendered yet. */
  quality: number;
  matchedAt: number;
  attempts: number;
  litWord: number;
  litParagraph: number;
  scrolledAt: number;
}

let follow: FollowState | null = null;
let followTimer: number | null = null;
let followUserScrolledAt = 0;
let followSheet: CSSStyleSheet | null = null;

function followSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
}

/** The highlight styles, adopted once; readable on a light or a dark page. */
function ensureFollowSheet(): void {
  if (followSheet !== null) return;
  followSheet = new CSSStyleSheet();
  followSheet.replaceSync(`
    ::highlight(${FOLLOW_PARAGRAPH_HIGHLIGHT}) { background-color: rgba(255, 196, 0, 0.16); }
    ::highlight(${FOLLOW_WORD_HIGHLIGHT}) { background-color: rgba(255, 190, 40, 0.9); color: #17201b; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, followSheet];
}

/** Whether a block boundary (or a line break) separates two text nodes. */
function followBoundaryBetween(previous: Text, next: Text): boolean {
  const seen = new Set<Node>();
  for (let node: Node | null = previous.parentNode; node !== null; node = node.parentNode) seen.add(node);
  let common: Node | null = null;
  for (let node: Node | null = next.parentNode; node !== null; node = node.parentNode) {
    if (seen.has(node)) {
      common = node;
      break;
    }
    if (node instanceof Element && FOLLOW_BLOCK_TAGS.has(node.tagName)) return true;
  }
  for (let node: Node | null = previous.parentNode; node !== null && node !== common; node = node.parentNode) {
    if (node instanceof Element && FOLLOW_BLOCK_TAGS.has(node.tagName)) return true;
  }
  return false;
}

/** The page's visible text, tokenized, with each token traceable back to its nodes. */
function collectFollowPage(): FollowPage {
  const nodes: FollowPage["nodes"] = [];
  const parts: string[] = [];
  let length = 0;
  let previous: Text | null = null;
  let lineBreak = false;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element) {
        if (FOLLOW_SKIPPED_TAGS.has(node.tagName) || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") {
          return NodeFilter.FILTER_REJECT;
        }
        return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Element) {
      lineBreak = true;
      continue;
    }
    if (!(node instanceof Text)) continue;
    const text = node.data;
    if (text === "") continue;
    if (previous !== null && (lineBreak || followBoundaryBetween(previous, node))) {
      parts.push("\n");
      length += 1;
    }
    lineBreak = false;
    nodes.push({ node, start: length, end: length + text.length });
    parts.push(text);
    length += text.length;
    previous = node;
  }
  const joined = parts.join("");
  const tokens: FollowPage["tokens"] = [];
  const tokenText: string[] = [];
  const pattern = /\S+/gu;
  for (let match = pattern.exec(joined); match !== null && tokens.length < FOLLOW_MAX_PAGE_TOKENS; match = pattern.exec(joined)) {
    tokens.push({ start: match.index, end: match.index + match[0].length });
    tokenText.push(match[0]);
  }
  return { nodes, tokens, tokenText };
}

/** The text node holding joined-text offset `offset`, by binary search. */
function followNodeAt(page: FollowPage, offset: number): { node: Text; start: number; end: number } | null {
  let low = 0;
  let high = page.nodes.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = page.nodes[middle]!;
    if (offset < entry.start) high = middle - 1;
    else if (offset >= entry.end) low = middle + 1;
    else return entry;
  }
  return null;
}

/** A DOM range over page tokens `from` through `to` (inclusive), or null if their nodes are gone. */
function followRange(page: FollowPage, from: number, to: number): Range | null {
  const first = page.tokens[from];
  const last = page.tokens[to];
  if (first === undefined || last === undefined) return null;
  const startNode = followNodeAt(page, first.start);
  const endNode = followNodeAt(page, last.end - 1);
  if (startNode === null || endNode === null || !startNode.node.isConnected || !endNode.node.isConnected) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode.node, Math.min(startNode.node.length, first.start - startNode.start));
    range.setEnd(endNode.node, Math.min(endNode.node.length, last.end - endNode.start));
  } catch {
    return null;
  }
  return range;
}

/** Match the clip's words against the page as it is now. */
function matchFollowPage(state: FollowState): void {
  const page = collectFollowPage();
  const clipWords = state.words.map((word) => state.script.text.slice(word.start, word.end));
  const matched = matchSpeechWords(clipWords, state.words.map((word) => word.paragraph), page.tokenText);
  let hits = 0;
  for (const index of matched) if (index !== -1) hits += 1;
  state.page = page;
  state.matched = matched;
  state.quality = clipWords.length === 0 ? 1 : hits / clipWords.length;
  state.matchedAt = Date.now();
  state.attempts += 1;
  state.litWord = -2;
  state.litParagraph = -2;
}

function setFollowHighlight(name: string, range: Range | null): void {
  if (!followSupported()) return;
  if (range === null) CSS.highlights.delete(name);
  else CSS.highlights.set(name, new Highlight(range));
}

function clearFollowHighlights(): void {
  setFollowHighlight(FOLLOW_WORD_HIGHLIGHT, null);
  setFollowHighlight(FOLLOW_PARAGRAPH_HIGHLIGHT, null);
}

/** The page tokens of a clip paragraph's first and last matched words. */
function followParagraphSpan(state: FollowState, paragraph: number): { from: number; to: number } | null {
  const matched = state.matched;
  if (matched === null) return null;
  let from = -1;
  let to = -1;
  state.words.forEach((word, index) => {
    if (word.paragraph !== paragraph || matched[index] === -1) return;
    if (from === -1) from = matched[index]!;
    to = matched[index]!;
  });
  return from === -1 ? null : { from, to };
}

/** Bring the lit word into view, unless the person is scrolling on their own. */
function scrollFollowIntoView(state: FollowState, range: Range): void {
  const now = Date.now();
  if (now - followUserScrolledAt < FOLLOW_SCROLL_GRACE_MS || now - state.scrolledAt < FOLLOW_SCROLL_GAP_MS) return;
  const rect = range.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) return;
  const margin = Math.min(80, window.innerHeight / 5);
  if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;
  state.scrolledAt = now;
  window.scrollBy({ top: rect.top - window.innerHeight * 0.4, behavior: "smooth" });
}

function renderFollow(): void {
  const state = follow;
  if (state === null || !followSupported()) return;
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  if (
    state.page === null ||
    (state.quality < FOLLOW_REMATCH_BELOW &&
      state.attempts < FOLLOW_REMATCH_ATTEMPTS &&
      now - state.matchedAt > FOLLOW_REMATCH_EVERY_MS)
  ) {
    matchFollowPage(state);
  }
  const { sync, page, matched } = state;
  if (sync === null || page === null || matched === null) return;
  const seconds = sync.position + (sync.playing ? ((now - sync.updatedAt) / 1_000) * sync.playbackRate : 0);
  const index = timedWordAt(state.timeline, seconds);
  if (index === -1) {
    if (state.litWord !== -1) clearFollowHighlights();
    state.litWord = -1;
    state.litParagraph = -1;
    return;
  }
  const word = state.timeline[index]!;
  if (word.paragraph !== state.litParagraph) {
    const span = followParagraphSpan(state, word.paragraph);
    setFollowHighlight(FOLLOW_PARAGRAPH_HIGHLIGHT, span === null ? null : followRange(page, span.from, span.to));
    state.litParagraph = word.paragraph;
  }
  if (index === state.litWord) return;
  state.litWord = index;
  // The timeline is a prefix of `words` (pieces tile the text from its start), so indexes agree.
  const token = matched[index] ?? -1;
  const range = token === -1 ? null : followRange(page, token, token);
  setFollowHighlight(FOLLOW_WORD_HIGHLIGHT, range);
  if (range !== null) scrollFollowIntoView(state, range);
}

function syncFollowLoop(): void {
  const running = follow !== null && follow.sync?.playing === true && document.visibilityState === "visible";
  if (running && followTimer === null) followTimer = window.setInterval(renderFollow, FOLLOW_TICK_MS);
  if (!running && followTimer !== null) {
    window.clearInterval(followTimer);
    followTimer = null;
  }
  renderFollow();
}

function noteUserScroll(): void {
  followUserScrolledAt = Date.now();
}

function startFollowListeners(): void {
  window.addEventListener("wheel", noteUserScroll, { passive: true });
  window.addEventListener("touchmove", noteUserScroll, { passive: true });
  window.addEventListener("keydown", noteUserScroll, { passive: true });
  document.addEventListener("visibilitychange", syncFollowLoop);
}

function stopFollow(): void {
  window.removeEventListener("wheel", noteUserScroll);
  window.removeEventListener("touchmove", noteUserScroll);
  window.removeEventListener("keydown", noteUserScroll);
  document.removeEventListener("visibilitychange", syncFollowLoop);
  follow = null;
  clearFollowHighlights();
  syncFollowLoop();
}

function isFollowSync(value: unknown): value is ReadAloudFollowSync {
  if (typeof value !== "object" || value === null) return false;
  const sync = value as Record<string, unknown>;
  return (
    typeof sync["position"] === "number" &&
    typeof sync["playing"] === "boolean" &&
    typeof sync["playbackRate"] === "number" &&
    typeof sync["updatedAt"] === "number"
  );
}

function isFollowScript(value: unknown): value is ReadAloudFollowScript {
  if (typeof value !== "object" || value === null) return false;
  const script = value as Record<string, unknown>;
  return (
    typeof script["clipId"] === "string" &&
    typeof script["text"] === "string" &&
    Array.isArray(script["pieces"]) &&
    typeof script["done"] === "boolean"
  );
}

ipcRenderer.on(READ_ALOUD_FOLLOW_CHANNEL, (_event, message: ReadAloudFollowMessage) => {
  if (typeof message !== "object" || message === null) return;
  if (message.type === "stop") {
    stopFollow();
    return;
  }
  if (message.type === "script") {
    if (!isFollowScript(message.script)) return;
    const { script } = message;
    const sync = isFollowSync(message.sync) ? message.sync : follow?.sync ?? null;
    if (follow === null) startFollowListeners();
    ensureFollowSheet();
    const sameClip = follow !== null && follow.script.clipId === script.clipId && follow.script.text === script.text;
    follow = {
      script,
      sync,
      words: sameClip ? follow!.words : speechWords(script.text),
      timeline: wordTimeline(script.text, script.pieces),
      page: sameClip ? follow!.page : null,
      matched: sameClip ? follow!.matched : null,
      quality: sameClip ? follow!.quality : 0,
      matchedAt: sameClip ? follow!.matchedAt : 0,
      attempts: sameClip ? follow!.attempts : 0,
      litWord: -2,
      litParagraph: -2,
      scrolledAt: sameClip ? follow!.scrolledAt : 0,
    };
    syncFollowLoop();
    return;
  }
  if (message.type === "sync") {
    if (follow === null || follow.script.clipId !== message.clipId || !isFollowSync(message.sync)) return;
    follow.sync = message.sync;
    syncFollowLoop();
  }
});
