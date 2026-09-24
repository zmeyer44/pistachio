/**
 * What a cloud tab reports back to the shell (docs/web-browser-design.md §11).
 *
 * On the desktop these three things are Chromium's own: the OS clipboard, the
 * native context menu, and the media-session metadata the isolated tab
 * preload forwards to main. A cloud page has none of them — the person's
 * clipboard is in THEIR browser, the right-click happened over an `<img>` of
 * a page, and there is no preload to run. So one init script does all three
 * through one exposed binding, and the host turns each report into either a
 * `StreamShellApi` event or a piece of the media stack.
 *
 * Everything the script sends is page-owned and therefore untrusted: the
 * shapes below are bounded here and re-validated by the contract's own
 * `normalizeTabMediaReport` before anything reaches a shell.
 */

import { randomBytes } from "node:crypto";
import type { Frame, Page } from "playwright-core";
import type {
  PageContextMenuParams,
  ContextMenuEditFlags,
  ContextMenuMediaFlags,
} from "@pistachio/shell-contracts/page-context-menu";
import { normalizeTabMediaReport, type TabMediaReport } from "@pistachio/shell-contracts/media";

/**
 * The name the page calls. It exists only inside this Space's own context,
 * and it is generated per session rather than fixed: a constant name is a
 * fingerprint every site can read ("this browser is a Pistachio worker") and
 * a function every site can probe. The value is never sent to a page except
 * as the property it must call, and the script hides it from enumeration.
 */
export function shellBridgeBinding(): string {
  return `__p${randomBytes(12).toString("hex")}`;
}

const MAX_CLIPBOARD_TEXT = 1_000_000;
const MAX_TARGET_TEXT = 4_000;
const MAX_TARGET_URL = 8_192;

/** One thing a tab told the host. */
export type TabReport =
  | { kind: "clipboard"; text: string }
  | { kind: "contextmenu"; x: number; y: number; target: PageContextMenuParams }
  | { kind: "media"; report: TabMediaReport | null }
  /**
   * A link to one of the browser's OWN pages was clicked (a `pistachio://`
   * href). There is no such protocol in a cloud tab, so the click cannot
   * navigate and the host answers it instead — which is how the welcome
   * pages link to each other (docs/web-browser-design.md §14).
   */
  | { kind: "link"; url: string }
  /**
   * The page asked for a capability; the answer is what the binding resolves.
   * The ORIGIN is deliberately absent: it is derived from the frame that
   * called, never from what the page put in the payload (see
   * `installTabBridge`).
   */
  | { kind: "permission"; permission: "geolocation" | "notifications" };

export interface TabBridgeHandlers {
  /**
   * A report arrived. A `permission` report is a QUESTION: whatever this
   * answers (a boolean, or a promise of one) is what the page's own call
   * resolves to, which is how a site's prompt becomes the shell's prompt.
   *
   * `origin` is the calling FRAME's own origin, resolved by Playwright, not
   * anything the page said. A binding is installed on every frame's window,
   * so an advertisement in an iframe can call it as easily as the page can —
   * and if the origin came from the payload, that iframe could name a site
   * the person has already allowed and spend its grant.
   */
  onReport(tabId: string, report: TabReport, origin: string): unknown;
}

/**
 * Copy and cut are mirrored rather than intercepted: the page keeps its own
 * clipboard behaviour inside the cloud browser, and the pane writes the same
 * text into the person's clipboard so a paste anywhere else finds it.
 *
 * `contextmenu` IS intercepted (`preventDefault`), because Chromium's own
 * menu would be drawn on a screen nobody is looking at.
 *
 * The media report is a compact cousin of the desktop tab preload's: the same
 * `TabMediaReport` fields, chosen from the same "most interesting element"
 * rule, debounced the same way so a `timeupdate` storm is one message.
 */
export function shellBridgeScript(binding: string): string {
  return `(() => {
  const NAME = ${JSON.stringify(binding)};
  const MARK = NAME + "$";
  if (Object.getOwnPropertyDescriptor(globalThis, MARK) !== undefined) return;
  Object.defineProperty(globalThis, MARK, { value: true, enumerable: false, configurable: true });
  // Playwright installs the binding as an ordinary enumerable global. Hide it
  // from \`Object.keys(globalThis)\` so a page cannot discover the name it was
  // given even by walking the window (the name itself is already random).
  const hide = () => {
    try {
      const at = Object.getOwnPropertyDescriptor(globalThis, NAME);
      if (at !== undefined && at.enumerable === true) {
        Object.defineProperty(globalThis, NAME, { ...at, enumerable: false });
      }
    } catch { /* a frozen window keeps its own counsel */ }
  };
  hide();
  const ask = (payload) => {
    try {
      hide();
      const report = globalThis[NAME];
      if (typeof report !== "function") return Promise.resolve(undefined);
      return Promise.resolve(report(payload)).catch(() => undefined);
    } catch { return Promise.resolve(undefined); }
  };
  const send = (payload) => { void ask(payload); };

  /* ------------------------------ permissions ----------------------------- */
  // A cloud page's prompt is the SHELL's prompt: Chromium here has no window
  // to draw one in, and the person is somewhere else entirely. So the two
  // capabilities a site can usefully be granted are wrapped, and the wrapper
  // waits for the answer the shell sends back. Camera and microphone are
  // wrapped too, and always refuse: the devices are on the person's machine,
  // not on this worker (W12).
  // The gate goes on the PROTOTYPE, not on \`navigator.geolocation\`. An own
  // property on the instance is one line from being bypassed —
  // \`Geolocation.prototype.getCurrentPosition.call(navigator.geolocation, …)\`
  // reaches the granted capability directly — and the shim exists precisely
  // to stand between a site and a grant it has not been given.
  const geoProto = typeof globalThis.Geolocation === "function" ? globalThis.Geolocation.prototype : null;
  if (geoProto !== null && typeof geoProto.getCurrentPosition === "function") {
    const nativeGet = geoProto.getCurrentPosition;
    const nativeWatch = typeof geoProto.watchPosition === "function" ? geoProto.watchPosition : null;
    const denied = (onError) => {
      if (typeof onError === "function") {
        onError({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "User denied Geolocation" });
      }
    };
    // No origin travels with the question: the host reads the calling frame's
    // own origin from Playwright, so an iframe cannot name somebody else.
    const gate = (run, onError) => {
      void ask({ kind: "permission", permission: "geolocation" }).then((granted) => {
        if (granted === true) run();
        else denied(onError);
      });
    };
    Object.defineProperty(geoProto, "getCurrentPosition", {
      configurable: true,
      writable: true,
      value: function (onOk, onError, options) {
        const self = this;
        gate(() => { nativeGet.call(self, onOk, onError, options); }, onError);
      },
    });
    if (nativeWatch !== null) {
      Object.defineProperty(geoProto, "watchPosition", {
        configurable: true,
        writable: true,
        value: function (onOk, onError, options) {
          const self = this;
          gate(() => { nativeWatch.call(self, onOk, onError, options); }, onError);
          return 0;
        },
      });
    }
  }
  // Notifications are in the report union, so they must actually be asked
  // for: without this the permission never reaches the shell and the prompt
  // the site is waiting on never appears.
  if (typeof globalThis.Notification === "function") {
    const notification = globalThis.Notification;
    let decided = null;
    Object.defineProperty(notification, "requestPermission", {
      configurable: true,
      writable: true,
      value: (callback) =>
        ask({ kind: "permission", permission: "notifications" }).then((granted) => {
          decided = granted === true ? "granted" : "denied";
          if (typeof callback === "function") { try { callback(decided); } catch { /* the page's own */ } }
          return decided;
        }),
    });
    Object.defineProperty(notification, "permission", {
      configurable: true,
      get: () => decided ?? "default",
    });
  }
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () =>
        Promise.reject(
          new DOMException(
            "The camera and microphone are on your own device, not in the cloud browser. Open this site in the desktop app.",
            "NotAllowedError",
          ),
        ),
    });
  }

  /* ------------------------------- clipboard ------------------------------ */
  const mirror = (event) => {
    let text = "";
    try { text = event.clipboardData ? event.clipboardData.getData("text/plain") : ""; } catch { text = ""; }
    if (text === "") { try { text = String(globalThis.getSelection() ?? ""); } catch { text = ""; } }
    if (text !== "") send({ kind: "clipboard", text });
  };
  document.addEventListener("copy", mirror, true);
  document.addEventListener("cut", mirror, true);

  /* ------------------------------ context menu ---------------------------- */
  const anchorOf = (node) => {
    for (let at = node; at; at = at.parentElement) {
      if (at.tagName === "A" && at.getAttribute("href") !== null) return at;
    }
    return null;
  };
  const absolute = (value) => {
    try { return new URL(value, document.baseURI).href; } catch { return ""; }
  };
  document.addEventListener("contextmenu", (event) => {
    // The shell draws the menu. Chromium's own would be on a screen nobody
    // is looking at, and the browser the person IS looking at draws its own
    // over the pane unless that one is prevented too (the pane does that).
    event.preventDefault();
    const node = event.target instanceof Element ? event.target : null;
    const anchor = node === null ? null : anchorOf(node);
    const image = node !== null && node.tagName === "IMG" ? node : null;
    const media = node !== null && (node.tagName === "VIDEO" || node.tagName === "AUDIO") ? node : null;
    const editable =
      node !== null &&
      (node.isContentEditable === true ||
        node.tagName === "TEXTAREA" ||
        (node.tagName === "INPUT" && !["button", "submit", "checkbox", "radio", "file", "image", "reset"].includes((node.type || "text").toLowerCase())));
    let selection = "";
    try { selection = String(globalThis.getSelection() ?? ""); } catch { selection = ""; }
    send({
      kind: "contextmenu",
      x: event.clientX,
      y: event.clientY,
      target: {
        linkURL: anchor === null ? "" : absolute(anchor.getAttribute("href") ?? ""),
        linkText: anchor === null ? "" : (anchor.textContent ?? ""),
        pageURL: location.href,
        srcURL: image !== null ? absolute(image.currentSrc || image.src || "") : media !== null ? absolute(media.currentSrc || media.src || "") : "",
        selectionText: selection,
        misspelledWord: "",
        dictionarySuggestions: [],
        hasImageContents: image !== null,
        isEditable: editable === true,
        mediaType: image !== null ? "image" : media === null ? "none" : media.tagName === "VIDEO" ? "video" : "audio",
        editFlags: {
          canUndo: editable === true,
          canRedo: editable === true,
          canCut: editable === true && selection !== "",
          canCopy: selection !== "",
          canPaste: editable === true,
          canDelete: editable === true && selection !== "",
          canSelectAll: true,
        },
        mediaFlags: {
          isLooping: media !== null && media.loop === true,
          canLoop: media !== null,
          isControlsVisible: media !== null && media.controls === true,
          canToggleControls: media !== null,
          isShowingPictureInPicture: media !== null && document.pictureInPictureElement === media,
          canShowPictureInPicture: media !== null && media.tagName === "VIDEO" && media.disablePictureInPicture !== true,
          canSave: media !== null,
        },
      },
    });
  }, true);

  /* ------------------------------ our own links --------------------------- */
  // A \`pistachio://\` link is the browser's own page, and this Chromium has no
  // handler for that scheme: left alone the click does nothing at all. So it
  // is reported, and the host navigates the tab to the document it names.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const node = event.target instanceof Element ? event.target : null;
    const anchor = node === null ? null : anchorOf(node);
    if (anchor === null) return;
    const url = absolute(anchor.getAttribute("href") ?? "");
    if (!url.startsWith("pistachio:")) return;
    event.preventDefault();
    send({ kind: "link", url });
  }, true);

  /* --------------------------------- media -------------------------------- */
  const engaged = new Set();
  const players = () => [...document.querySelectorAll("video,audio")];
  const score = (media) => {
    let value = 0;
    if (!media.paused && !media.ended) value += 1_000_000;
    if (document.pictureInPictureElement === media) value += 500_000;
    if (engaged.has(media)) value += 10_000;
    const box = media.getBoundingClientRect ? media.getBoundingClientRect() : { width: 0, height: 0 };
    return value + box.width * box.height;
  };
  const primary = () => {
    let best = null;
    for (const media of players()) {
      if (best === null || score(media) > score(best)) best = media;
    }
    return best;
  };
  const meta = () => {
    try { return navigator.mediaSession?.metadata ?? null; } catch { return null; }
  };
  const reportFor = (media) => {
    const data = meta();
    const artwork = data && data.artwork && data.artwork.length > 0 ? data.artwork[data.artwork.length - 1].src : null;
    const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null;
    const video = media.tagName === "VIDEO";
    return {
      title: (data?.title || document.title || "").slice(0, 300),
      artist: (data?.artist || "").slice(0, 200),
      album: (data?.album || "").slice(0, 200),
      artworkUrl: artwork === null ? null : absolute(artwork),
      kind: duration === null ? "live" : video ? "video" : "audio",
      hasVideo: video,
      playing: !media.paused && !media.ended,
      elementMuted: media.muted === true,
      position: Number.isFinite(media.currentTime) ? media.currentTime : 0,
      duration,
      playbackRate: Number.isFinite(media.playbackRate) ? media.playbackRate : 1,
      seekable: duration !== null,
      canPrevious: false,
      canNext: false,
      canPictureInPicture: video && media.disablePictureInPicture !== true,
      canSetRate: duration !== null,
      presenting: document.pictureInPictureElement === media || document.fullscreenElement === media,
      stream: typeof MediaStream !== "undefined" && media.srcObject instanceof MediaStream,
    };
  };
  let last = "";
  let timer = null;
  const publish = () => {
    timer = null;
    const media = primary();
    const report = media === null ? null : reportFor(media);
    const key = JSON.stringify(report === null ? null : { ...report, position: 0 });
    if (key === last) return;
    last = key;
    send({ kind: "media", report });
  };
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(publish, 250);
  };
  for (const type of ["play", "playing", "pause", "ended", "durationchange", "loadedmetadata", "volumechange", "emptied", "ratechange", "enterpictureinpicture", "leavepictureinpicture"]) {
    globalThis.addEventListener(type, (event) => {
      if (event.target instanceof HTMLMediaElement) engaged.add(event.target);
      schedule();
    }, true);
  }
  schedule();
})();`;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function editFlags(value: unknown): ContextMenuEditFlags {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    canUndo: bool(raw["canUndo"]),
    canRedo: bool(raw["canRedo"]),
    canCut: bool(raw["canCut"]),
    canCopy: bool(raw["canCopy"]),
    canPaste: bool(raw["canPaste"]),
    canDelete: bool(raw["canDelete"]),
    canSelectAll: bool(raw["canSelectAll"]),
  };
}

function mediaFlags(value: unknown): ContextMenuMediaFlags {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    isLooping: bool(raw["isLooping"]),
    canLoop: bool(raw["canLoop"]),
    isControlsVisible: bool(raw["isControlsVisible"]),
    canToggleControls: bool(raw["canToggleControls"]),
    isShowingPictureInPicture: bool(raw["isShowingPictureInPicture"]),
    canShowPictureInPicture: bool(raw["canShowPictureInPicture"]),
    canSave: bool(raw["canSave"]),
  };
}

const MEDIA_TYPES = new Set(["none", "image", "audio", "video", "canvas", "file", "plugin"]);

/** Bound what the page said the pointer was over, before the builder sees it. */
export function contextTarget(value: unknown): PageContextMenuParams | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const mediaType = raw["mediaType"];
  return {
    linkURL: text(raw["linkURL"], MAX_TARGET_URL),
    pageURL: text(raw["pageURL"], MAX_TARGET_URL),
    srcURL: text(raw["srcURL"], MAX_TARGET_URL),
    selectionText: text(raw["selectionText"], MAX_TARGET_TEXT),
    misspelledWord: text(raw["misspelledWord"], 200),
    dictionarySuggestions: [],
    hasImageContents: bool(raw["hasImageContents"]),
    isEditable: bool(raw["isEditable"]),
    mediaType: (typeof mediaType === "string" && MEDIA_TYPES.has(mediaType)
      ? mediaType
      : "none") as PageContextMenuParams["mediaType"],
    editFlags: editFlags(raw["editFlags"]),
    mediaFlags: mediaFlags(raw["mediaFlags"]),
  };
}

/** Turn one raw binding payload into a `TabReport`, or drop it. */
export function tabReport(value: unknown): TabReport | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw["kind"] === "clipboard") {
    const copied = text(raw["text"], MAX_CLIPBOARD_TEXT);
    return copied === "" ? null : { kind: "clipboard", text: copied };
  }
  if (raw["kind"] === "contextmenu") {
    const target = contextTarget(raw["target"]);
    if (target === null) return null;
    const x = typeof raw["x"] === "number" && Number.isFinite(raw["x"]) ? raw["x"] : 0;
    const y = typeof raw["y"] === "number" && Number.isFinite(raw["y"]) ? raw["y"] : 0;
    return { kind: "contextmenu", x, y, target };
  }
  if (raw["kind"] === "permission") {
    const permission = raw["permission"];
    if (permission !== "geolocation" && permission !== "notifications") return null;
    // Whatever origin the payload carried is ignored: the frame's is used.
    return { kind: "permission", permission };
  }
  if (raw["kind"] === "link") {
    const url = text(raw["url"], MAX_TARGET_URL);
    // Only the browser's own scheme: this is not a general navigation
    // channel a page can use to steer its own tab anywhere.
    return url.startsWith("pistachio:") ? { kind: "link", url } : null;
  }
  if (raw["kind"] === "media") {
    return { kind: "media", report: raw["report"] === null ? null : normalizeTabMediaReport(raw["report"]) };
  }
  return null;
}

/**
 * Install the bridge in one page: the binding, the script for every future
 * document, and the same script in the document that is already there — a tab
 * the host adopted mid-life must not need a reload to report anything.
 *
 * Failures are swallowed on purpose. A page that closed while this ran, or a
 * binding some other holder of this context already installed, is not a
 * reason for the tab to stop working; it only means the shell gets no report
 * from it, which the affordances already treat as "nothing here".
 */
export async function installTabBridge(
  page: Page,
  tabId: string,
  handlers: TabBridgeHandlers,
  binding: string,
): Promise<void> {
  const script = shellBridgeScript(binding);
  await page
    .exposeBinding(binding, (source: { frame: Frame }, payload: unknown) => {
      const report = tabReport(payload);
      if (report === null) return undefined;
      // The ANSWER matters, not only the delivery: a `permission` report is
      // the page's own call waiting on what the person decides, and returning
      // nothing here is the same as refusing it.
      return handlers.onReport(tabId, report, frameOrigin(source.frame));
    })
    .catch(() => undefined);
  await page.addInitScript(script).catch(() => undefined);
  await page.evaluate(script).catch(() => undefined);
}

/**
 * The origin of the frame that called the binding, as Playwright resolved it
 * — the one piece of a report a page cannot choose. An opaque origin (a
 * sandboxed iframe, `about:blank`, a `data:` document) answers "", which
 * every caller treats as "no site asked".
 */
export function frameOrigin(frame: Frame): string {
  try {
    const url = new URL(frame.url());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}
