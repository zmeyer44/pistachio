import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeScreenShareReport,
  screenShareObject,
  watchScreenShares,
  type TabScreenShareReport,
} from "../src/screen-share.js";

/**
 * The page-world half of screen sharing, run the way Electron runs it: from
 * its source text, so a reference to anything outside the function fails
 * here rather than in the page. The capture classes are small fakes with the
 * shape Chromium gives them (getters on the prototype, stop() firing
 * nothing, a source end firing `ended`), made fresh per test because the
 * watcher wraps their prototypes.
 */
const serialized = new Function(`return (${watchScreenShares.toString()});`)() as typeof watchScreenShares;

interface Capture {
  devices: MediaDevices;
  /** Tracks the fake's getDisplayMedia handed out, in order. */
  handedOut: MediaStreamTrack[][];
  /** The capture source ends on its own (macOS's Stop Sharing). */
  endSource(track: MediaStreamTrack): void;
  /** The next getDisplayMedia() is refused, as a dismissed picker is. */
  refuseNext(): void;
}

const globals = globalThis as Record<string, unknown>;
const saved = ["MediaDevices", "MediaStreamTrack", "MediaStream"].map((name) => [name, globals[name]] as const);
afterEach(() => {
  for (const [name, value] of saved) globals[name] = value;
});

function installCapture(surface: string | null = "monitor", withAudio = true): Capture {
  class FakeTrack extends EventTarget {
    #state: "live" | "ended" = "live";
    readonly #kind: "audio" | "video";
    constructor(kind: "audio" | "video") {
      super();
      this.#kind = kind;
    }
    get readyState(): "live" | "ended" {
      return this.#state;
    }
    get kind(): "audio" | "video" {
      return this.#kind;
    }
    getSettings(): MediaTrackSettings {
      return this.#kind === "video" && surface !== null ? { displaySurface: surface } : {};
    }
    stop(): void {
      this.#state = "ended";
    }
    clone(): FakeTrack {
      return twin(this);
    }
    endSource(): void {
      if (this.#state === "ended") return;
      this.#state = "ended";
      this.dispatchEvent(new Event("ended"));
    }
  }
  /** The engine's own clone, which never goes through the page-visible method. */
  const twin = (track: FakeTrack): FakeTrack => new FakeTrack(track.kind);
  class FakeStream {
    readonly #tracks: FakeTrack[];
    constructor(tracks: FakeTrack[]) {
      this.#tracks = tracks;
    }
    getAudioTracks(): FakeTrack[] {
      return this.#tracks.filter((track) => track.kind === "audio");
    }
    getVideoTracks(): FakeTrack[] {
      return this.#tracks.filter((track) => track.kind === "video");
    }
    getTracks(): FakeTrack[] {
      return [...this.#tracks];
    }
    clone(): FakeStream {
      return new FakeStream(this.#tracks.map(twin));
    }
  }
  const handedOut: MediaStreamTrack[][] = [];
  let refuse = false;
  class FakeDevices {
    getDisplayMedia(): Promise<FakeStream> {
      if (refuse) {
        refuse = false;
        return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      }
      const tracks = withAudio ? [new FakeTrack("video"), new FakeTrack("audio")] : [new FakeTrack("video")];
      handedOut.push(tracks as unknown as MediaStreamTrack[]);
      return Promise.resolve(new FakeStream(tracks));
    }
  }
  globals["MediaDevices"] = FakeDevices;
  globals["MediaStreamTrack"] = FakeTrack;
  globals["MediaStream"] = FakeStream;
  return {
    devices: new FakeDevices() as unknown as MediaDevices,
    handedOut,
    endSource: (track) => (track as unknown as FakeTrack).endSource(),
    refuseNext: () => {
      refuse = true;
    },
  };
}

function watch(): { reports: Array<TabScreenShareReport | null>; stop: () => void } {
  const reports: Array<TabScreenShareReport | null> = [];
  const stop = serialized((state) => reports.push(state));
  return { reports, stop };
}

describe("watchScreenShares", () => {
  it("reports what the page was handed, and null once the page stops it", async () => {
    const capture = installCapture("window");
    const { reports } = watch();
    const stream = await capture.devices.getDisplayMedia({ video: true, audio: true });
    expect(reports).toEqual([{ surface: "window", audio: true }]);

    stream.getAudioTracks()[0]!.stop();
    expect(reports.at(-1)).toEqual({ surface: "window", audio: false });
    stream.getVideoTracks()[0]!.stop();
    expect(reports.at(-1)).toBeNull();
    expect(reports).toHaveLength(3);
  });

  it("names each display surface the way the chrome says it", async () => {
    for (const [displaySurface, surface] of [
      ["monitor", "screen"],
      ["window", "window"],
      ["browser", "tab"],
      [null, "unknown"],
    ] as const) {
      const capture = installCapture(displaySurface, false);
      const { reports } = watch();
      await capture.devices.getDisplayMedia({ video: true });
      expect(reports, String(displaySurface)).toEqual([{ surface, audio: false }]);
    }
  });

  it("hears the source end: macOS's own Stop Sharing", async () => {
    const capture = installCapture();
    const { reports } = watch();
    await capture.devices.getDisplayMedia({ video: true, audio: true });
    for (const track of capture.handedOut[0]!) capture.endSource(track);
    expect(reports.at(-1)).toBeNull();
  });

  it("stops every captured track and tells the page, as a browser's stop button does", async () => {
    const capture = installCapture();
    const { reports, stop } = watch();
    const stream = await capture.devices.getDisplayMedia({ video: true, audio: true });
    const heard = vi.fn();
    for (const track of stream.getTracks()) track.addEventListener("ended", heard);

    stop();
    expect(stream.getTracks().map((track) => track.readyState)).toEqual(["ended", "ended"]);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(reports.at(-1)).toBeNull();
  });

  it("keeps the share on while a clone of it still captures", async () => {
    const capture = installCapture("monitor", false);
    const { reports, stop } = watch();
    const stream = await capture.devices.getDisplayMedia({ video: true });
    const [original] = stream.getVideoTracks();
    const trackClone = original!.clone();
    const streamClone = stream.clone();

    original!.stop();
    expect(reports.at(-1)).toEqual({ surface: "screen", audio: false });
    trackClone.stop();
    expect(reports.at(-1)).toEqual({ surface: "screen", audio: false });
    // The chrome's stop reaches the stream clone the page kept.
    stop();
    expect(streamClone.getVideoTracks()[0]!.readyState).toBe("ended");
    expect(reports.at(-1)).toBeNull();
  });

  it("follows every share the page starts, until the last one ends", async () => {
    const capture = installCapture("monitor", false);
    const { reports } = watch();
    const first = await capture.devices.getDisplayMedia({ video: true });
    const second = await capture.devices.getDisplayMedia({ video: true });
    first.getVideoTracks()[0]!.stop();
    expect(reports.at(-1)).not.toBeNull();
    second.getVideoTracks()[0]!.stop();
    expect(reports.at(-1)).toBeNull();
  });

  it("says nothing about a request that was refused", async () => {
    const capture = installCapture();
    const { reports } = watch();
    capture.refuseNext();
    await expect(capture.devices.getDisplayMedia({ video: true })).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(reports).toEqual([]);
  });

  it("leaves the tracks of other captures alone", async () => {
    installCapture();
    const { reports } = watch();
    const Track = globals["MediaStreamTrack"] as new (kind: "audio" | "video") => MediaStreamTrack;
    const camera = new Track("video");
    camera.stop();
    expect(camera.readyState).toBe("ended");
    expect(reports).toEqual([]);
  });

  it("wraps nothing a page can tell from the built-in by its name, length, or source", () => {
    installCapture();
    const prototypeOf = (name: string) => (globals[name] as { prototype: Record<string, (...args: never[]) => unknown> }).prototype;
    const wrapped = [
      ["MediaDevices", "getDisplayMedia"],
      ["MediaStreamTrack", "stop"],
      ["MediaStreamTrack", "clone"],
      ["MediaStream", "clone"],
    ] as const;
    const before = wrapped.map(([owner, name]) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototypeOf(owner), name)!;
      return { ...descriptor, value: undefined, fn: descriptor.value as (...args: never[]) => unknown };
    });
    watch();
    wrapped.forEach(([owner, name], index) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototypeOf(owner), name)!;
      const wrapper = descriptor.value as (...args: never[]) => unknown;
      const original = before[index]!;
      expect(wrapper, `${owner}.${name}`).not.toBe(original.fn);
      expect(wrapper.name).toBe(original.fn.name);
      expect(wrapper.length).toBe(original.fn.length);
      expect(Function.prototype.toString.call(wrapper)).toContain("[native code]");
      expect({ ...descriptor, value: undefined }).toEqual({ ...original, fn: undefined, value: undefined });
    });
  });

  it("does nothing where the page cannot capture (no secure context)", () => {
    globals["MediaDevices"] = undefined;
    const { reports, stop } = watch();
    expect(() => stop()).not.toThrow();
    expect(reports).toEqual([]);
  });
});

describe("screen share reports", () => {
  it("accepts a report and nothing else", () => {
    expect(normalizeScreenShareReport({ surface: "tab", audio: true })).toEqual({ surface: "tab", audio: true });
    expect(normalizeScreenShareReport({ surface: "tab", audio: true, extra: 1 })).toEqual({ surface: "tab", audio: true });
    expect(normalizeScreenShareReport({ surface: "desktop", audio: true })).toBeNull();
    expect(normalizeScreenShareReport({ surface: "screen" })).toBeNull();
    expect(normalizeScreenShareReport("screen")).toBeNull();
    expect(normalizeScreenShareReport(null)).toBeNull();
  });

  it("says what is shared", () => {
    expect(screenShareObject("screen")).toBe("your screen");
    expect(screenShareObject("unknown")).toBe("your screen");
    expect(screenShareObject("window")).toBe("a window");
    expect(screenShareObject("tab")).toBe("a tab");
  });
});
