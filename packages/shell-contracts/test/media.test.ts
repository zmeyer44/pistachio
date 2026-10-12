import { afterEach, describe, expect, it } from "vitest";
import { defaultRateAnswer, defaultRateVerdict, isMediaControl, normalizeTabMediaReport, watchMediaPlays } from "../src/media.js";
import { applySettingsPatch, DEFAULT_SETTINGS, sanitizeSettings } from "../src/settings.js";

const validReport = {
  title: "A very good track",
  artist: "Pistachio Radio",
  album: "Workspace Mix",
  artworkUrl: "https://example.com/cover.png",
  kind: "audio",
  hasVideo: false,
  playing: true,
  elementMuted: false,
  volume: 1,
  position: 12.5,
  duration: 180,
  playbackRate: 1,
  seekable: true,
  canPrevious: true,
  canNext: true,
  canPictureInPicture: false,
  canSetRate: true,
  stream: false,
  presenting: false,
};

describe("media IPC data", () => {
  it("normalizes a valid tab report without trusting its identity", () => {
    expect(normalizeTabMediaReport(validReport)).toEqual(validReport);
  });

  it("bounds page-owned metadata and timing", () => {
    const normalized = normalizeTabMediaReport({
      ...validReport,
      title: `  title\u0000${"x".repeat(500)}  `,
      position: 400,
      duration: 100,
      playbackRate: 99,
      volume: 4,
      artworkUrl: "javascript:alert(1)",
    });
    expect(normalized).toMatchObject({
      position: 100,
      duration: 100,
      playbackRate: 16,
      volume: 1,
      artworkUrl: null,
    });
    expect(normalizeTabMediaReport({ ...validReport, volume: -1 })?.volume).toBe(0);
    expect(normalized?.title.startsWith("title ")).toBe(true);
    expect(normalized?.title.length).toBeLessThanOrEqual(300);
  });

  it("rejects malformed reports and controls", () => {
    expect(normalizeTabMediaReport({ ...validReport, playing: "yes" })).toBeNull();
    expect(normalizeTabMediaReport({ ...validReport, hasVideo: "yes" })).toBeNull();
    expect(normalizeTabMediaReport({ ...validReport, duration: Number.NaN })).toBeNull();
    expect(isMediaControl({ type: "seek", position: 25 })).toBe(true);
    expect(isMediaControl({ type: "seek", position: Number.NaN })).toBe(false);
    expect(isMediaControl({ type: "pause" })).toBe(true);
    expect(isMediaControl({ type: "eraseEverything" })).toBe(false);
    expect(isMediaControl({ type: "setRate", rate: 1.5 })).toBe(true);
    expect(isMediaControl({ type: "setRate", rate: 0 })).toBe(false);
    expect(isMediaControl({ type: "setRate", rate: 9 })).toBe(false);
    expect(isMediaControl({ type: "followText", enabled: true })).toBe(true);
    expect(isMediaControl({ type: "followText", enabled: "yes" })).toBe(false);
    // Turned all the way down, the level Unmute brings it back to, kept in the page's player.
    expect(isMediaControl({ type: "setVolume", volume: 0, restore: 0.4 })).toBe(true);
    expect(isMediaControl({ type: "setVolume", volume: 0, restore: 0 })).toBe(false);
    expect(isMediaControl({ type: "setVolume", volume: 0, restore: 2 })).toBe(false);
    expect(isMediaControl({ type: "setVolume", volume: 0, restore: Number.NaN })).toBe(false);
    expect(isMediaControl({ type: "setVolume", volume: 0.5, restore: 0.4 })).toBe(false);
    expect(normalizeTabMediaReport({ ...validReport, canSetRate: "yes" })).toBeNull();
    expect(normalizeTabMediaReport({ ...validReport, stream: undefined })).toBeNull();
    // Each player's own volume: 0 to 1, said, or the report is no report.
    expect(normalizeTabMediaReport({ ...validReport, volume: undefined })).toBeNull();
    expect(isMediaControl({ type: "setVolume", volume: 0.4 })).toBe(true);
    expect(isMediaControl({ type: "setVolume", volume: 0 })).toBe(true);
    expect(isMediaControl({ type: "setVolume", volume: 1.5 })).toBe(false);
    expect(isMediaControl({ type: "setVolume", volume: Number.NaN })).toBe(false);
    expect(isMediaControl({ type: "setVolume" })).toBe(false);
  });
});

describe("the default playback speed (Settings → General)", () => {
  const started = { duration: 300, stream: false, loop: false, muted: false, playbackRate: 1 };

  it("starts a file at normal speed at the default", () => {
    expect(defaultRateVerdict(started)).toBe("apply");
    // A muted video that does not loop is still watched: a feed's, with captions.
    expect(defaultRateVerdict({ ...started, muted: true })).toBe("apply");
    expect(defaultRateVerdict({ ...started, loop: true })).toBe("apply");
  });

  it("waits for a length, and leaves streams, live media and muted loops alone", () => {
    expect(defaultRateVerdict({ ...started, duration: Number.NaN })).toBe("wait");
    expect(defaultRateVerdict({ ...started, duration: Number.POSITIVE_INFINITY })).toBe("skip");
    expect(defaultRateVerdict({ ...started, stream: true })).toBe("skip");
    expect(defaultRateVerdict({ ...started, stream: true, duration: Number.NaN })).toBe("skip");
    expect(defaultRateVerdict({ ...started, loop: true, muted: true })).toBe("skip");
  });

  it("keeps a speed the page started its player at", () => {
    expect(defaultRateVerdict({ ...started, playbackRate: 1.25 })).toBe("skip");
    expect(defaultRateVerdict({ ...started, playbackRate: 0.5 })).toBe("skip");
  });

  it("takes only a speed the media card could set as main's answer", () => {
    expect(defaultRateAnswer(1.5)).toBe(1.5);
    expect(defaultRateAnswer(1)).toBe(1);
    expect(defaultRateAnswer(0)).toBeNull();
    expect(defaultRateAnswer(9)).toBeNull();
    expect(defaultRateAnswer(Number.NaN)).toBeNull();
    expect(defaultRateAnswer("1.5")).toBeNull();
    expect(defaultRateAnswer(undefined)).toBeNull();
  });

  it("is normal speed unless chosen, and only one of the offered speeds", () => {
    expect(DEFAULT_SETTINGS.media.defaultPlaybackRate).toBe(1);
    // A file written before the setting existed.
    expect(sanitizeSettings({ general: {} }).media.defaultPlaybackRate).toBe(1);
    expect(sanitizeSettings({ media: { defaultPlaybackRate: 1.5 } }).media.defaultPlaybackRate).toBe(1.5);
    expect(sanitizeSettings({ media: { defaultPlaybackRate: 1.3 } }).media.defaultPlaybackRate).toBe(1);
    expect(sanitizeSettings({ media: { defaultPlaybackRate: "2" } }).media.defaultPlaybackRate).toBe(1);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { media: { defaultPlaybackRate: 1.75 } }).media.defaultPlaybackRate).toBe(1.75);
  });
});

/**
 * The page-world half, run the way Electron runs it: from its source text,
 * so a reference to anything outside the function fails here rather than in
 * the page. The DOM is a small fake with Chromium's shape (`isConnected` a
 * getter on Node, `play` a method on the media prototype), made fresh per
 * test because the watcher wraps the prototype.
 */
describe("media the document's events never carry", () => {
  const serialized = new Function(`return (${watchMediaPlays.toString()});`)() as typeof watchMediaPlays;
  const globals = globalThis as Record<string, unknown>;
  const saved = ["Node", "Element", "HTMLMediaElement", "document"].map((name) => [name, globals[name]] as const);
  afterEach(() => {
    for (const [name, value] of saved) globals[name] = value;
  });

  function installDom() {
    class FakeNode extends EventTarget {
      /** What getRootNode() answers; null while the node is in no tree. */
      root: FakeNode | null = null;
      get isConnected(): boolean {
        return this.root !== null;
      }
      getRootNode(): FakeNode {
        return this.root ?? this;
      }
    }
    class FakeElement extends FakeNode {
      #shadow: FakeNode | null = null;
      attachShadow(init: { mode: "open" | "closed" }): FakeNode {
        if (init.mode !== "open" && init.mode !== "closed") throw new TypeError("mode is required");
        if (this.#shadow !== null) throw new Error("NotSupportedError: already a shadow host");
        this.#shadow = new FakeNode();
        this.#shadow.root = this.#shadow;
        return this.#shadow;
      }
    }
    class FakeMedia extends FakeElement {
      plays = 0;
      play(): Promise<void> {
        if (!(this instanceof FakeMedia)) throw new TypeError("Illegal invocation");
        this.plays += 1;
        return Promise.resolve();
      }
    }
    const page = new FakeNode();
    page.root = page;
    const shadow = new FakeNode();
    shadow.root = shadow;
    globals["Node"] = FakeNode;
    globals["Element"] = FakeElement;
    globals["HTMLMediaElement"] = FakeMedia;
    globals["document"] = page;
    const media = (root: FakeNode | null) => Object.assign(new FakeMedia(), { root });
    return { FakeElement, FakeMedia, page, shadow, media };
  }

  it("reports media played outside the document or in a shadow root, once, and not the document's own", async () => {
    const { page, shadow, media } = installDom();
    const reported: unknown[] = [];
    serialized((element) => reported.push(element));
    const detached = media(null);
    const shadowed = media(shadow);
    const inDocument = media(page);
    for (const element of [detached, shadowed, inDocument, detached]) await element.play();
    expect(reported).toEqual([detached, shadowed]);
    // Played all the same.
    expect([detached.plays, shadowed.plays, inDocument.plays]).toEqual([2, 1, 1]);
  });

  it("never fails the page's play(), and refuses what the built-ins refuse", async () => {
    const { FakeElement, FakeMedia, media } = installDom();
    const playDescriptor = Object.getOwnPropertyDescriptor(FakeMedia.prototype, "play");
    const attachDescriptor = Object.getOwnPropertyDescriptor(FakeElement.prototype, "attachShadow");
    serialized(() => {
      throw new Error("the bridge is gone");
    });
    const detached = media(null);
    await expect(detached.play()).resolves.toBeUndefined();
    expect(detached.plays).toBe(1);
    expect(() => FakeMedia.prototype.play.call({} as never)).toThrow(TypeError);
    // A shadow root is still the built-in's, and a second one still refused.
    const host = new FakeElement();
    const root = host.attachShadow({ mode: "closed" });
    expect(root.getRootNode()).toBe(root);
    expect(() => host.attachShadow({ mode: "open" })).toThrow(/already a shadow host/);
    // Kept as writable, configurable and hidden as the methods they replaced.
    const shape = (descriptor: PropertyDescriptor | undefined) => ({ ...descriptor, value: undefined });
    expect(shape(Object.getOwnPropertyDescriptor(FakeMedia.prototype, "play"))).toEqual(shape(playDescriptor));
    expect(shape(Object.getOwnPropertyDescriptor(FakeElement.prototype, "attachShadow"))).toEqual(shape(attachDescriptor));
  });
});
