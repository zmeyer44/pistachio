/**
 * Screen sharing from a tab: a page's getDisplayMedia() capture, followed
 * from the moment the page receives it until its last track has ended, so
 * the chrome can say for exactly that long that the screen is being shared,
 * and stop it.
 *
 * WHY THE PAGE'S OWN WORLD IS WATCHED: Electron tells main that a page ASKED
 * for the screen (the permission request) but not whether the person then
 * went through with macOS's picker — on macOS 15 the picker answers the page
 * without main's display-media handler ever running — nor when the capture
 * ends. The page's world is the one place that sees both, so the tab preload
 * runs `watchScreenShares` there before any script of the page's own, and
 * relays what it reports to main (apps/desktop/src/preload/tab.ts).
 */

/** What is shared, from MediaTrackSettings.displaySurface: monitor, window, or browser. */
export type ScreenShareSurface = "screen" | "window" | "tab" | "unknown";

/** The tab's report while something is shared; the preload sends null once nothing is. */
export interface TabScreenShareReport {
  surface: ScreenShareSurface;
  /** The share carries sound as well as the picture. */
  audio: boolean;
}

/** One tab's share, as main publishes it to the chrome (ShellSnapshot.screenShares). */
export interface ScreenShareInfo extends TabScreenShareReport {
  tabId: string;
  /** The Space the tab is in: a share goes on when the person switches away. */
  spaceId: string;
  tabTitle: string;
  tabUrl: string;
  faviconUrl: string | null;
  startedAt: number;
}

const SURFACES = new Set<ScreenShareSurface>(["screen", "window", "tab", "unknown"]);

/** Validate a page-owned report; null when it is not one. */
export function normalizeScreenShareReport(value: unknown): TabScreenShareReport | null {
  if (typeof value !== "object" || value === null) return null;
  const report = value as Record<string, unknown>;
  if (!SURFACES.has(report["surface"] as ScreenShareSurface) || typeof report["audio"] !== "boolean") return null;
  return { surface: report["surface"] as ScreenShareSurface, audio: report["audio"] };
}

/** "your screen", "a window", "a tab": what follows "Sharing" in the chrome. */
export function screenShareObject(surface: ScreenShareSurface): string {
  return surface === "window" ? "a window" : surface === "tab" ? "a tab" : "your screen";
}

/**
 * Runs in the PAGE's world, before any of its scripts (the tab preload hands
 * it to contextBridge.executeInMainWorld): every track getDisplayMedia()
 * hands the page is followed from then on, and `report` hears what is shared
 * whenever that changes, and null once nothing is. Returns the chrome's
 * "Stop sharing".
 *
 * SELF-CONTAINED ON PURPOSE: Electron serializes the function into the page,
 * so it closes over nothing — no import, no module constant — and keeps its
 * own references to the built-ins it wraps, taken before the page can
 * replace them. Each wrapper is a Proxy of the built-in, so what the page can
 * read off it — its name, its length, a source that says native code — is
 * what it would read off the built-in itself.
 *
 * A share ends when its source does (macOS's own Stop Sharing, which fires
 * `ended` on every track), when the page stops its tracks (stop() fires
 * nothing, hence the wrapper), or on the chrome's stop, which stops every
 * captured track and then fires the `ended` a page listens for — what a
 * browser's own stop button looks like from inside the page. A clone
 * captures as long as its original does, so track.clone() and
 * stream.clone() are followed too.
 */
export function watchScreenShares(report: (state: TabScreenShareReport | null) => void): () => void {
  const Devices = globalThis.MediaDevices;
  const Track = globalThis.MediaStreamTrack;
  const Stream = globalThis.MediaStream;
  // MediaDevices is secure-context only: this page can capture nothing.
  if (typeof Devices?.prototype?.getDisplayMedia !== "function" || Track === undefined || Stream === undefined) {
    return () => {};
  }
  const getDisplayMedia = Devices.prototype.getDisplayMedia;
  const stopTrack = Track.prototype.stop;
  const cloneTrack = Track.prototype.clone;
  const cloneStream = Stream.prototype.clone;
  const audioTracks = Stream.prototype.getAudioTracks;
  const videoTracks = Stream.prototype.getVideoTracks;
  const trackSettings = Track.prototype.getSettings;
  const readyState = Object.getOwnPropertyDescriptor(Track.prototype, "readyState")?.get;
  const kind = Object.getOwnPropertyDescriptor(Track.prototype, "kind")?.get;
  const listen = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const TrackEvent = Event;
  const call = Reflect.apply;
  if (readyState === undefined || kind === undefined) return () => {};

  const live = new Set<MediaStreamTrack>();
  let reported = "null";

  const publish = (): void => {
    let surface: ScreenShareSurface | null = null;
    let audio = false;
    for (const track of live) {
      if (readyState.call(track) === "ended") {
        live.delete(track);
        continue;
      }
      if (kind.call(track) === "audio") {
        audio = true;
        continue;
      }
      if (surface !== null) continue;
      const displaySurface = trackSettings.call(track).displaySurface;
      surface =
        displaySurface === "monitor"
          ? "screen"
          : displaySurface === "window"
            ? "window"
            : displaySurface === "browser"
              ? "tab"
              : "unknown";
    }
    const state: TabScreenShareReport | null = live.size === 0 ? null : { surface: surface ?? "unknown", audio };
    const key = state === null ? "null" : `${state.surface}:${String(state.audio)}`;
    if (key === reported) return;
    reported = key;
    report(state);
  };

  const follow = (track: MediaStreamTrack): void => {
    if (live.has(track)) return;
    live.add(track);
    listen.call(track, "ended", publish);
  };

  /**
   * Where the page finds `name`, put a Proxy of the built-in that runs
   * `after` on what it returned — kept as writable and enumerable as the
   * property it replaces. A call the built-in refuses throws as it would.
   */
  const intercept = <T, R>(target: object, name: string, builtIn: (this: T, ...args: never[]) => R, after: (self: T, result: R) => R): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor === undefined) return;
    const value = new Proxy(builtIn, {
      apply: (fn, self: T, args: never[]) => after(self, call(fn, self, args)),
    });
    Object.defineProperty(target, name, { ...descriptor, value });
  };

  intercept<MediaDevices, Promise<MediaStream>>(Devices.prototype, "getDisplayMedia", getDisplayMedia, (_devices, granted) =>
    granted.then((stream) => {
      for (const track of audioTracks.call(stream)) follow(track);
      for (const track of videoTracks.call(stream)) follow(track);
      publish();
      return stream;
    }),
  );
  intercept<MediaStreamTrack, void>(Track.prototype, "stop", stopTrack, (track) => {
    if (live.has(track)) publish();
  });
  intercept<MediaStreamTrack, MediaStreamTrack>(Track.prototype, "clone", cloneTrack, (track, copy) => {
    if (live.has(track)) follow(copy);
    return copy;
  });
  intercept<MediaStream, MediaStream>(Stream.prototype, "clone", cloneStream, (stream, copy) => {
    // A clone lists its tracks in its original's order, kind by kind.
    for (const tracksOf of [audioTracks, videoTracks]) {
      const copies = tracksOf.call(copy);
      tracksOf.call(stream).forEach((track, index) => {
        const twin = copies[index];
        if (twin !== undefined && live.has(track)) follow(twin);
      });
    }
    return copy;
  });

  return () => {
    const tracks = [...live];
    for (const track of tracks) stopTrack.call(track);
    for (const track of tracks) dispatch.call(track, new TrackEvent("ended"));
    publish();
  };
}
