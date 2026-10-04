/**
 * Shields in the page (docs/shields.md §5): what the tab preload asks main
 * for at document start, and the protections it runs in the PAGE's own
 * world before any script of the page's.
 *
 * The tab preload is the only runtime importer of this module — the shell
 * preload must never import it, or Rollup splits it into a chunk the
 * sandboxed tab preload cannot `require` (see desk-now-playing's trap).
 */

/** What main answers the preload's synchronous `pistachio:shields-frame` with. */
export interface ShieldsFrameBootstrap {
  /** Element-hiding CSS for this page, injected as a user style sheet. */
  styles: string;
  /** Scriptlets (uBlock Origin's `##+js(...)`), run in the page's world in order. */
  scripts: string[];
  /** Watch the DOM and ask for the generic hiding rules its classes and ids call for. */
  watchDom: boolean;
  protections: PageProtections;
}

export interface PageProtections {
  globalPrivacyControl: boolean;
  fingerprinting: "off" | "standard" | "strict";
  /** This run's seed for this site: the same canvas reads the same here, and differently on any other site. */
  seed: number;
}

/** What the preload reports as the DOM grows (`pistachio:shields-cosmetics`). */
export interface ShieldsDomFeatures {
  classes: string[];
  ids: string[];
  hrefs: string[];
}

export const SHIELDS_FRAME_CHANNEL = "pistachio:shields-frame";
export const SHIELDS_COSMETICS_CHANNEL = "pistachio:shields-cosmetics";
/** Caps on one report, so a page churning its DOM cannot flood main. */
export const MAX_DOM_FEATURES = 2_000;

/**
 * Runs in the PAGE's world (contextBridge.executeInMainWorld), before any of
 * its scripts, in the top frame — and, through the iframe accessors, in the
 * same-origin frames it makes, which fingerprinting scripts use to reach
 * unpatched copies of the APIs.
 *
 * Fingerprinting `standard` is Brave's farbling: what canvas, WebGL, and
 * audio READ BACK gets a little noise from a per-run, per-site seed and the
 * content read, so a site sees the same values all session (nothing visibly
 * changes, nothing re-renders) while two sites cannot join their readings,
 * and no reading of a known image gives the noise away; and the core
 * count is rounded down at random. `strict` also takes away the APIs that
 * are mostly fingerprint — battery, network information, voices, the WebGL
 * renderer string — and reports the screen as the window, as Firefox's
 * resistFingerprinting does.
 *
 * SELF-CONTAINED ON PURPOSE: Electron serializes the function into the page,
 * so it closes over nothing — no import, no module constant.
 */
export function installPageProtections(config: PageProtections): void {
  const root = window;
  const wrapped = new WeakMap<object, string>();
  const done = new WeakSet<object>();
  const nativeToString = Function.prototype.toString;

  /** Make `fake` print as `original` does: patched functions do not announce themselves. */
  const disguise = <T extends object>(fake: T, original: object): T => {
    wrapped.set(fake, nativeToString.call(original));
    return fake;
  };

  const rng = (salt: number) => {
    let state = (config.seed ^ salt) >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /**
   * A digest of what is being read. The noise is seeded by it as well as by
   * the site, so it depends on the content: noise that did not would be the
   * same over a black canvas as over the fingerprint, and a script could
   * read the one to subtract it from the other.
   */
  const digest = (data: ArrayBufferView): number => {
    let hash = (0x811c9dc5 ^ data.byteLength) >>> 0;
    const bytes = data.byteLength;
    const words = data.byteOffset % 4 === 0 && bytes % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, bytes / 4) : null;
    if (words !== null) {
      for (let index = 0; index < words.length; index += 1) {
        hash ^= words[index] ?? 0;
        hash = Math.imul(hash, 0x01000193);
      }
    } else {
      const raw = new Uint8Array(data.buffer, data.byteOffset, bytes);
      for (let index = 0; index < raw.length; index += 1) {
        hash ^= raw[index] ?? 0;
        hash = Math.imul(hash, 0x01000193);
      }
    }
    return hash >>> 0;
  };

  /** Flip the low bit of a seeded sparse set of channels: invisible, and stable for this site, this content, and this run. */
  const farblePixels = (data: Uint8ClampedArray | Uint8Array, salt: number): void => {
    const next = rng(salt ^ digest(data));
    const pixels = data.length >> 2;
    if (pixels === 0) return;
    const step = Math.max(1, Math.floor(pixels / 1024));
    for (let pixel = Math.floor(next() * step); pixel < pixels; pixel += step + Math.floor(next() * step)) {
      const index = pixel * 4 + Math.floor(next() * 3);
      data[index] = (data[index] ?? 0) ^ 1;
    }
  };

  /**
   * Floating-point pixels (getImageData's `rgba-float16`): no bit to flip, so
   * a seeded sparse set of channels moves by 2⁻¹¹ — about one float16 step
   * near the middle of the range, well under anything visible.
   */
  const farbleFloats = (data: ArrayBufferView & { length: number; [index: number]: number }, salt: number): void => {
    const next = rng(salt ^ digest(data));
    const pixels = data.length >> 2;
    if (pixels === 0) return;
    const step = Math.max(1, Math.floor(pixels / 1024));
    for (let pixel = Math.floor(next() * step); pixel < pixels; pixel += step + Math.floor(next() * step)) {
      const index = pixel * 4 + Math.floor(next() * 3);
      data[index] = (data[index] ?? 0) + (next() < 0.5 ? -1 : 1) / 2048;
    }
  };

  /** Noise for whatever a getImageData answered: bytes, or floats. */
  const farbleImage = (image: ImageData, salt: number): void => {
    const data = image.data as unknown;
    if (Object.prototype.toString.call(data) === "[object Uint8ClampedArray]") farblePixels(data as Uint8ClampedArray, salt);
    else if (ArrayBuffer.isView(data) && !(data instanceof DataView)) farbleFloats(data as ArrayBufferView & { length: number; [index: number]: number }, salt);
  };

  const defineGetter = (target: object, name: string, get: () => unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const fake = function (this: unknown) {
      return get.call(this);
    };
    if (descriptor?.get !== undefined) disguise(fake, descriptor.get);
    Object.defineProperty(target, name, { get: fake, configurable: true, enumerable: descriptor?.enumerable ?? true });
  };

  const install = (win: typeof window): void => {
    // Keyed by the realm, not the window: a frame navigated to another
    // same-origin document keeps its WindowProxy but gets fresh globals,
    // which need the protections again.
    const realm = win.Object;
    if (done.has(realm)) return;
    done.add(realm);
    // A frame whose own preload already protected it (every frame of a page
    // runs Shields from its first script) is left alone: installing twice
    // would noise its readings twice, and set them apart from the page's.
    // The page-world toString lies about patched functions; this realm's
    // native one, taken before anything was patched, does not.
    if (win !== root) {
      try {
        if (!nativeToString.call(win.Function.prototype.toString).includes("[native code]")) return;
      } catch {
        return;
      }
    }

    // Patched functions print as the natives they replace.
    const toString = function (this: unknown) {
      const disguised = typeof this === "function" || typeof this === "object" ? wrapped.get(this as object) : undefined;
      return disguised ?? nativeToString.call(this as () => void);
    };
    wrapped.set(toString, nativeToString.call(nativeToString));
    win.Function.prototype.toString = toString;

    if (config.globalPrivacyControl && !("globalPrivacyControl" in win.Navigator.prototype)) {
      const fake = function globalPrivacyControl() {
        return true;
      };
      wrapped.set(fake, "function get globalPrivacyControl() { [native code] }");
      Object.defineProperty(win.Navigator.prototype, "globalPrivacyControl", { get: fake, configurable: true, enumerable: true });
    }

    // Same-origin frames the page makes get the same treatment before it can use them.
    const frameGetter = (name: "contentWindow" | "contentDocument") => {
      const descriptor = Object.getOwnPropertyDescriptor(win.HTMLIFrameElement.prototype, name);
      const original = descriptor?.get;
      if (original === undefined) return;
      const fake = function (this: HTMLIFrameElement) {
        const value = original.call(this) as Window | Document | null;
        try {
          const child = value === null ? null : name === "contentWindow" ? (value as Window) : (value as Document).defaultView;
          if (child !== null && child !== undefined) install(child as typeof window);
        } catch {
          // Cross-origin: not ours to reach, and not the page's either.
        }
        return value;
      };
      disguise(fake, original);
      Object.defineProperty(win.HTMLIFrameElement.prototype, name, { ...descriptor, get: fake });
    };
    frameGetter("contentWindow");
    frameGetter("contentDocument");
    for (const method of ["appendChild", "insertBefore", "replaceChild"] as const) {
      const original = win.Node.prototype[method] as (...args: unknown[]) => unknown;
      const fake = function (this: Node, ...args: unknown[]) {
        const result = original.apply(this, args);
        const node = args[0];
        if (node instanceof win.HTMLIFrameElement) {
          try {
            if (node.contentWindow !== null) install(node.contentWindow as typeof window);
          } catch {
            // Cross-origin.
          }
        }
        return result;
      };
      win.Node.prototype[method] = disguise(fake, original) as never;
    }

    if (config.fingerprinting === "off") return;

    // ── Canvas ─────────────────────────────────────────────────────────────
    // Each canvas's context, kept as the page makes it, so an export's
    // noised copy is drawn in the canvas's own color space: a default (sRGB)
    // copy of a Display-P3 canvas would clip its colors, not just noise them.
    const contexts = new WeakMap<object, unknown>();
    const colorSpaceOf = (canvas: object): PredefinedColorSpace => {
      const context = contexts.get(canvas) as
        | { drawingBufferColorSpace?: PredefinedColorSpace; getContextAttributes?: () => { colorSpace?: PredefinedColorSpace } | null }
        | undefined;
      try {
        return context?.drawingBufferColorSpace ?? context?.getContextAttributes?.()?.colorSpace ?? "srgb";
      } catch {
        return "srgb";
      }
    };
    for (const proto of [win.HTMLCanvasElement?.prototype, win.OffscreenCanvas?.prototype]) {
      const getContext = proto?.getContext as ((...args: unknown[]) => unknown) | undefined;
      if (proto === undefined || getContext === undefined) continue;
      proto.getContext = disguise(function (this: object, ...args: unknown[]) {
        const context = getContext.apply(this, args);
        if (context !== null && context !== undefined) contexts.set(this, context);
        return context;
      }, getContext) as never;
    }
    const Context2D = win.CanvasRenderingContext2D?.prototype;
    const getImageData = Context2D?.getImageData;
    if (Context2D !== undefined && getImageData !== undefined) {
      const fake = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof getImageData>) {
        const image = getImageData.apply(this, args);
        farbleImage(image, 0x1d2);
        return image;
      };
      Context2D.getImageData = disguise(fake, getImageData);
    }
    const Canvas = win.HTMLCanvasElement?.prototype;
    if (Canvas !== undefined && getImageData !== undefined) {
      /** A farbled copy of the canvas, or the canvas itself when it cannot be read or is huge. */
      const farbledCopy = (canvas: HTMLCanvasElement): HTMLCanvasElement => {
        const { width, height } = canvas;
        if (width === 0 || height === 0 || width * height > 16_000_000) return canvas;
        try {
          const colorSpace = colorSpaceOf(canvas);
          const copy = win.document.createElement("canvas");
          copy.width = width;
          copy.height = height;
          const context = copy.getContext("2d", { colorSpace });
          if (context === null) return canvas;
          context.drawImage(canvas, 0, 0);
          const image = getImageData.call(context, 0, 0, width, height, { colorSpace });
          farbleImage(image, 0x1d2);
          context.putImageData(image, 0, 0);
          return copy;
        } catch {
          return canvas;
        }
      };
      const toDataURL = Canvas.toDataURL;
      Canvas.toDataURL = disguise(function (this: HTMLCanvasElement, ...args: Parameters<typeof toDataURL>) {
        return toDataURL.apply(farbledCopy(this), args);
      }, toDataURL);
      const toBlob = Canvas.toBlob;
      Canvas.toBlob = disguise(function (this: HTMLCanvasElement, ...args: Parameters<typeof toBlob>) {
        return toBlob.apply(farbledCopy(this), args);
      }, toBlob);
    }
    const OffscreenContext = win.OffscreenCanvasRenderingContext2D?.prototype;
    const offscreenGetImageData = OffscreenContext?.getImageData;
    if (OffscreenContext !== undefined && offscreenGetImageData !== undefined) {
      OffscreenContext.getImageData = disguise(function (this: OffscreenCanvasRenderingContext2D, ...args: Parameters<typeof offscreenGetImageData>) {
        const image = offscreenGetImageData.apply(this, args);
        farbleImage(image, 0x1d2);
        return image;
      }, offscreenGetImageData);
      // A blob export is a readback too, as toBlob is for a canvas.
      const Offscreen = win.OffscreenCanvas?.prototype;
      const convertToBlob = Offscreen?.convertToBlob;
      if (Offscreen !== undefined && convertToBlob !== undefined) {
        const farbledOffscreen = (canvas: OffscreenCanvas): OffscreenCanvas => {
          const { width, height } = canvas;
          if (width === 0 || height === 0 || width * height > 16_000_000) return canvas;
          try {
            const colorSpace = colorSpaceOf(canvas);
            const copy = new win.OffscreenCanvas(width, height);
            const context = copy.getContext("2d", { colorSpace });
            if (context === null) return canvas;
            context.drawImage(canvas, 0, 0);
            const image = offscreenGetImageData.call(context, 0, 0, width, height, { colorSpace });
            farbleImage(image, 0x1d2);
            context.putImageData(image, 0, 0);
            return copy;
          } catch {
            return canvas;
          }
        };
        Offscreen.convertToBlob = disguise(function (this: OffscreenCanvas, ...args: Parameters<typeof convertToBlob>) {
          return convertToBlob.apply(farbledOffscreen(this), args);
        }, convertToBlob);
      }
    }

    // ── WebGL ──────────────────────────────────────────────────────────────
    for (const [GL, webgl2] of [
      [win.WebGLRenderingContext, false],
      [win.WebGL2RenderingContext, true],
    ] as const) {
      const proto = GL?.prototype as WebGLRenderingContext | undefined;
      if (proto === undefined) continue;
      const readPixels = proto.readPixels as (...args: unknown[]) => void;
      const nativeGetParameter = proto.getParameter;
      proto.readPixels = disguise(function (this: WebGLRenderingContext, ...args: unknown[]) {
        readPixels.apply(this, args);
        // Only the pixels the read wrote, where pixel-pack state put them:
        // RGBA/UNSIGNED_BYTE, rows PACK_ALIGNMENT-aligned, and in WebGL2
        // PACK_ROW_LENGTH / SKIP_ROWS / SKIP_PIXELS and the destination offset.
        // A reused buffer's other bytes are the page's; other formats are
        // left alone. A buffer from another realm is still a Uint8Array.
        const [, , width, height, format, type, pixels, offset] = args;
        const tag = Object.prototype.toString.call(pixels);
        if (tag !== "[object Uint8Array]" && tag !== "[object Uint8ClampedArray]") return;
        if (format !== 0x1908 || type !== 0x1401 || typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return;
        const bytes = pixels as Uint8Array;
        const parameter = (name: number) => {
          const value = nativeGetParameter.call(this, name) as unknown;
          return typeof value === "number" && value > 0 ? value : 0;
        };
        const alignment = parameter(0x0d05) || 4;
        const rowLength = (webgl2 ? parameter(0x0d02) : 0) || width;
        const skipRows = webgl2 ? parameter(0x0d03) : 0;
        const skipPixels = webgl2 ? parameter(0x0d04) : 0;
        const stride = Math.ceil((rowLength * 4) / alignment) * alignment;
        const base = (typeof offset === "number" && offset > 0 ? offset : 0) + skipRows * stride + skipPixels * 4;
        // Past the end, the native call wrote nothing (it refused the read).
        if (base + (height - 1) * stride + width * 4 > bytes.length) return;
        const region = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row += 1) region.set(bytes.subarray(base + row * stride, base + row * stride + width * 4), row * width * 4);
        farblePixels(region, 0x61);
        for (let row = 0; row < height; row += 1) bytes.set(region.subarray(row * width * 4, (row + 1) * width * 4), base + row * stride);
      }, readPixels) as never;
      if (config.fingerprinting === "strict") {
        const getParameter = proto.getParameter;
        proto.getParameter = disguise(function (this: WebGLRenderingContext, name: number) {
          // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL: the GPU's model.
          if (name === 0x9245 || name === 0x9246) return null;
          return getParameter.call(this, name) as unknown;
        }, getParameter) as never;
        const getExtension = proto.getExtension;
        proto.getExtension = disguise(function (this: WebGLRenderingContext, name: string) {
          if (name === "WEBGL_debug_renderer_info") return null;
          return getExtension.call(this, name) as unknown;
        }, getExtension) as never;
      }
    }

    // ── Audio ──────────────────────────────────────────────────────────────
    const AudioBufferProto = win.AudioBuffer?.prototype;
    if (AudioBufferProto !== undefined) {
      const farbled = new WeakSet<Float32Array>();
      const noise = (samples: Float32Array): void => {
        const next = rng(0xa0d ^ digest(samples));
        const step = Math.max(1, Math.floor(samples.length / 2048));
        for (let index = Math.floor(next() * step); index < samples.length; index += step) {
          samples[index] = (samples[index] ?? 0) + (next() - 0.5) * 1e-7;
        }
      };
      const getChannelData = AudioBufferProto.getChannelData;
      AudioBufferProto.getChannelData = disguise(function (this: AudioBuffer, channel: number) {
        const samples = getChannelData.call(this, channel);
        // The live array is the buffer's own: noised once, or a second read would noise the noise.
        if (!farbled.has(samples)) {
          farbled.add(samples);
          noise(samples);
        }
        return samples;
      }, getChannelData);
      const copyFromChannel = AudioBufferProto.copyFromChannel;
      AudioBufferProto.copyFromChannel = disguise(function (this: AudioBuffer, destination: Float32Array<ArrayBuffer>, ...rest: [number, number?]) {
        // Every copy overwrites the destination with clean samples: each one
        // is noised — only as far as the copy reached, never the tail of a
        // destination longer than what was left to copy.
        copyFromChannel.call(this, destination, ...rest);
        const copied = Math.max(0, Math.min(destination.length, this.length - (rest[1] ?? 0)));
        if (copied > 0) noise(destination.subarray(0, copied));
      }, copyFromChannel) as never;
    }
    const Analyser = win.AnalyserNode?.prototype;
    if (Analyser !== undefined) {
      const floatFrequency = Analyser.getFloatFrequencyData;
      Analyser.getFloatFrequencyData = disguise(function (this: AnalyserNode, array: Float32Array) {
        floatFrequency.call(this, array as never);
        // The analyser writes frequencyBinCount values; the rest is the page's.
        const written = array.subarray(0, Math.min(array.length, this.frequencyBinCount));
        const next = rng(0xa0e ^ digest(written));
        for (let index = 0; index < written.length; index += 16) written[index] = (written[index] ?? 0) + (next() - 0.5) * 1e-4;
      }, floatFrequency) as never;
    }

    // ── Hardware ───────────────────────────────────────────────────────────
    const cores = win.navigator.hardwareConcurrency;
    if (typeof cores === "number" && cores > 2) {
      const reported = 2 + Math.floor(rng(0xc0e)() * (cores - 1));
      defineGetter(win.Navigator.prototype, "hardwareConcurrency", () => reported);
    }

    if (config.fingerprinting !== "strict") return;

    // ── Strict: APIs that are mostly fingerprint ───────────────────────────
    const NavigatorProto = win.Navigator.prototype as unknown as Record<string, unknown>;
    if ("getBattery" in NavigatorProto) delete NavigatorProto["getBattery"];
    if ("connection" in NavigatorProto) defineGetter(NavigatorProto, "connection", () => undefined);
    if (win.speechSynthesis !== undefined) {
      const Synthesis = win.SpeechSynthesis.prototype;
      const getVoices = Synthesis.getVoices;
      Synthesis.getVoices = disguise(function () {
        return [];
      }, getVoices);
    }
    const ScreenProto = win.Screen?.prototype;
    if (ScreenProto !== undefined) {
      defineGetter(ScreenProto, "width", () => win.innerWidth);
      defineGetter(ScreenProto, "height", () => win.innerHeight);
      defineGetter(ScreenProto, "availWidth", () => win.innerWidth);
      defineGetter(ScreenProto, "availHeight", () => win.innerHeight);
      defineGetter(ScreenProto, "colorDepth", () => 24);
      defineGetter(ScreenProto, "pixelDepth", () => 24);
      for (const name of ["availLeft", "availTop"]) if (name in ScreenProto) defineGetter(ScreenProto, name, () => 0);
    }
  };

  try {
    install(root);
  } catch {
    // A page that froze its prototypes keeps them; Shields never breaks a load.
  }
}
