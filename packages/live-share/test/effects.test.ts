import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { copyEffectsAssets, EFFECTS_ASSET_DIR, effectsAssets } from "../assets/index.mjs";
import type { LiveBackground } from "../src/effects.js";

/** A processor as the effects module was handed it: its options (`onFrameProcessed` among them) and its transformer's first-frame switch. */
interface FakeProcessor {
  name: string;
  options: { onFrameProcessed?: () => void } & Record<string, unknown>;
  transformer: { isFirstFrame?: boolean };
  switchTo: Mock;
  destroy: Mock;
}

/**
 * What the effects module was handed of `@livekit/track-processors`, and
 * whether it was loaded at all. `firstFrameSwitch: false` makes processors
 * as a version without `transformer.isFirstFrame` would be.
 */
const processors = vi.hoisted(() => ({ loaded: 0, created: [] as FakeProcessor[], firstFrameSwitch: true }));

vi.mock("@livekit/track-processors", () => {
  processors.loaded += 1;
  return {
    supportsBackgroundProcessors: () => true,
    BackgroundProcessor: (options: FakeProcessor["options"], name: string) => {
      const processor: FakeProcessor = {
        name,
        options,
        transformer: processors.firstFrameSwitch ? { isFirstFrame: true } : {},
        switchTo: vi.fn(async () => undefined),
        destroy: vi.fn(async () => undefined),
      };
      processors.created.push(processor);
      return processor;
    },
  };
});

const MODEL_SHA256 = "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b";

describe("the segmenter's files", () => {
  it("are put where the effects load them from", async () => {
    const { EFFECTS_ASSET_PATH } = await import("../src/effects.js");
    expect(EFFECTS_ASSET_PATH).toBe(`/${EFFECTS_ASSET_DIR}`);
  });

  it("are MediaPipe's WASM at the version the processor bundles, and the vendored model", async () => {
    const assets = effectsAssets();
    expect(assets.map((asset) => asset.path).sort()).toEqual([
      "selfie_segmenter.tflite",
      "wasm/vision_wasm_internal.js",
      "wasm/vision_wasm_internal.wasm",
      "wasm/vision_wasm_nosimd_internal.js",
      "wasm/vision_wasm_nosimd_internal.wasm",
    ]);
    for (const asset of assets) expect((await stat(asset.source)).size).toBeGreaterThan(0);

    // The WASM must match the JavaScript bundled with the processor: the same package, as it resolves it.
    const wasm = assets.find((asset) => asset.path === "wasm/vision_wasm_internal.wasm")!.source;
    const vision = JSON.parse(await readFile(join(dirname(wasm), "..", "package.json"), "utf8")) as { name: string; version: string };
    const processorsManifest = createRequire(import.meta.url).resolve("@livekit/track-processors/package.json");
    const pinned = (JSON.parse(await readFile(processorsManifest, "utf8")) as { dependencies: Record<string, string> }).dependencies["@mediapipe/tasks-vision"];
    expect(vision).toMatchObject({ name: "@mediapipe/tasks-vision", version: pinned });

    // The model is the one assets/README.md names.
    const model = assets.find((asset) => asset.path === "selfie_segmenter.tflite")!.source;
    expect(createHash("sha256").update(await readFile(model)).digest("hex")).toBe(MODEL_SHA256);
  });

  it("leave out MediaPipe's no-SIMD build when asked", () => {
    expect(effectsAssets({ simdFallback: false }).map((asset) => asset.path).sort()).toEqual(["selfie_segmenter.tflite", "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm"]);
  });

  describe("copied under a folder", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "live-effects-assets-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("land at their paths, and a stale copy is replaced while a current one is left alone", async () => {
      const options = { simdFallback: false };
      copyEffectsAssets(dir, options);
      for (const asset of effectsAssets(options)) expect((await stat(join(dir, asset.path))).size).toBe((await stat(asset.source)).size);
      const loader = effectsAssets(options).find((asset) => asset.path === "wasm/vision_wasm_internal.js")!;
      const copied = (await stat(join(dir, loader.path))).mtimeMs;

      copyEffectsAssets(dir, options);
      expect((await stat(join(dir, loader.path))).mtimeMs).toBe(copied);

      // Another MediaPipe's loader, left by an earlier copy.
      await writeFile(join(dir, loader.path), "stale");
      copyEffectsAssets(dir, options);
      expect(await readFile(join(dir, loader.path), "utf8")).toBe(await readFile(loader.source, "utf8"));
    });
  });
});

/**
 * A camera track as livekit-client's LocalVideoTrack holds a processor:
 * setting one waits on its segmenter (`loading`, held while a test holds
 * it), and stopping the track destroys the one it has.
 *
 * Its processed track runs as `@livekit/track-processors` 0.8.1 runs it
 * (probed on Chromium's fake camera): just after `setProcessor` resolves —
 * LiveKit has swapped a published camera onto that track by then — the
 * first frame goes out as it came, unprocessed, unless the transformer was
 * told to start past it (`isFirstFrame` false); processed frames follow once
 * the segmenter gives a picture (`picture`, held while a test holds it), each
 * reported through `onFrameProcessed`. `out` is every frame it carried: what
 * a published camera sends.
 */
function fakeCamera() {
  let processor: FakeProcessor | undefined;
  const camera = {
    loading: Promise.resolve(),
    picture: Promise.resolve(),
    out: [] as Array<"raw" | "processed">,
    getProcessor: () => processor,
    setProcessor: vi.fn(async (next: FakeProcessor) => {
      // (Read as LiveKit hands it over: its init starts the pipeline.)
      const passesFirst = next.transformer.isFirstFrame !== false;
      await camera.loading;
      processor = next;
      void Promise.resolve().then(async () => {
        if (passesFirst) camera.out.push("raw");
        await camera.picture;
        if (processor !== next) return;
        camera.out.push("processed");
        next.options.onFrameProcessed?.();
      });
    }),
    stop: vi.fn(() => {
      void processor?.destroy?.();
      processor = undefined;
    }),
  };
  return camera;
}

/** What a camera shows behind the person now: its processor's mode (the last it was switched to), or none. */
function showing(camera: ReturnType<typeof fakeCamera>): { mode: string; blurRadius?: number } {
  const processor = processors.created.find((each) => each === camera.getProcessor());
  if (processor === undefined) return { mode: "none" };
  const { mode, blurRadius } = ((processor.switchTo.mock.calls as unknown[][]).at(-1)?.[0] ?? processor.options) as { mode: string; blurRadius?: number };
  return mode === "disabled" ? { mode: "none" } : { mode, ...(blurRadius === undefined ? {} : { blurRadius }) };
}

/** What `supportsBackgroundProcessors` looks for: a document with WebGL 2, frames, a track processor. */
function stubBrowser(): { contexts: () => number; lost: () => number } {
  let contexts = 0;
  let lost = 0;
  const webgl2 = { getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext: () => void (lost += 1) } : null) };
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: (kind: string) => {
        contexts += 1;
        return kind === "webgl2" ? webgl2 : null;
      },
    }),
  });
  for (const name of ["OffscreenCanvas", "VideoFrame", "MediaStreamTrackProcessor", "MediaStreamTrackGenerator"]) vi.stubGlobal(name, class {});
  vi.stubGlobal("createImageBitmap", () => undefined);
  return { contexts: () => contexts, lost: () => lost };
}

describe("applyBackground", () => {
  beforeEach(() => {
    vi.resetModules();
    processors.loaded = 0;
    processors.created.length = 0;
    processors.firstFrameSwitch = true;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const effects = () => import("../src/effects.js");
  const apply = async (camera: ReturnType<typeof fakeCamera>, background: LiveBackground, assetPath?: string) =>
    (await effects()).applyBackground(camera as never, background, assetPath === undefined ? {} : { assetPath });

  it("never loads the processor for a camera with no background", async () => {
    stubBrowser();
    const camera = fakeCamera();
    expect(await apply(camera, { kind: "none" })).toBe(true);
    expect(camera.setProcessor).not.toHaveBeenCalled();
    expect(processors.loaded).toBe(0);
  });

  it("loads it with the first effect, its files from the page's own origin, and switches that one processor after", async () => {
    stubBrowser();
    const camera = fakeCamera();
    expect(await apply(camera, { kind: "blur" })).toBe(true);
    expect(processors.loaded).toBe(1);
    expect(processors.created).toHaveLength(1);
    const [processor] = processors.created;
    expect(processor).toMatchObject({
      name: "live-background",
      options: {
        mode: "background-blur",
        blurRadius: 16,
        assetPaths: { tasksVisionFileSet: "/live/mediapipe/wasm", modelAssetPath: "/live/mediapipe/selfie_segmenter.tflite" },
      },
    });
    expect(camera.setProcessor).toHaveBeenCalledWith(processor);

    const scene = { kind: "image", url: "data:image/svg+xml,scene", label: "Dusk" } as const;
    expect(await apply(camera, scene)).toBe(true);
    expect(await apply(camera, { kind: "blur", strength: "light" })).toBe(true);
    expect(await apply(camera, { kind: "none" })).toBe(true);
    expect(processor!.switchTo.mock.calls).toEqual([[{ mode: "virtual-background", imagePath: scene.url }], [{ mode: "background-blur", blurRadius: 6 }], [{ mode: "disabled" }]]);
    expect(processors.created).toHaveLength(1);
    expect(camera.setProcessor).toHaveBeenCalledTimes(1);
  });

  it("ends on the choice made last when choices come while the processor loads", async () => {
    stubBrowser();
    const { applyBackground } = await effects();
    // Blur, then No background before the processor has loaded: no background, and nothing installed for the blur.
    const taken = fakeCamera();
    expect(await Promise.all([applyBackground(taken as never, { kind: "blur" }), applyBackground(taken as never, { kind: "none" })])).toEqual([true, true]);
    expect(showing(taken)).toEqual({ mode: "none" });
    expect(taken.setProcessor).not.toHaveBeenCalled();

    // Three choices in a row: the last one shows, on one processor (one segmenter load).
    const camera = fakeCamera();
    const scene = { kind: "image", url: "data:image/svg+xml,scene", label: "Dusk" } as const;
    await Promise.all([applyBackground(camera as never, { kind: "blur" }), applyBackground(camera as never, scene), applyBackground(camera as never, { kind: "blur", strength: "light" })]);
    expect(showing(camera)).toEqual({ mode: "background-blur", blurRadius: 6 });
    expect(camera.setProcessor).toHaveBeenCalledTimes(1);
  });

  it("puts back the background a camera had when another does not load, and says which one it shows", async () => {
    stubBrowser();
    const { applyBackground, backgroundOn } = await effects();
    const scene = { kind: "image", url: "blob:the-picture", label: "Your picture" } as const;
    const blur = { kind: "blur" } as const;

    const camera = fakeCamera();
    await applyBackground(camera as never, blur);
    // A picture that does not load: the processor is left between the two, so the blur goes back on.
    const [processor] = processors.created;
    processor!.switchTo.mockRejectedValueOnce(new Error("the picture did not load"));
    await expect(applyBackground(camera as never, scene)).rejects.toThrow("the picture did not load");
    expect(showing(camera)).toEqual({ mode: "background-blur", blurRadius: 16 });
    expect(backgroundOn(camera as never)).toBe(blur);
    // And when even the blur cannot go back on, nobody can say what it shows.
    processor!.switchTo.mockRejectedValueOnce(new Error("the picture did not load")).mockRejectedValueOnce(new Error("lost"));
    await expect(applyBackground(camera as never, scene)).rejects.toThrow("the picture did not load");
    expect(backgroundOn(camera as never)).toBeNull();

    // The first effect on a camera that does not load (the segmenter): nothing was put on it.
    const fresh = fakeCamera();
    fresh.setProcessor.mockRejectedValueOnce(new Error("the segmenter did not load"));
    await expect(applyBackground(fresh as never, blur)).rejects.toThrow("the segmenter did not load");
    expect(showing(fresh)).toEqual({ mode: "none" });
    expect(backgroundOn(fresh as never)).toEqual({ kind: "none" });
  });

  it("lets a processor go with a camera stopped for good while its segmenter loaded, and makes none for one stopped before", async () => {
    stubBrowser();
    const { applyBackground, stopCamera } = await effects();
    const camera = fakeCamera();
    let loaded = (): void => undefined;
    camera.loading = new Promise((resolve) => (loaded = resolve));
    const applying = applyBackground(camera as never, { kind: "blur" });
    await vi.waitFor(() => expect(camera.setProcessor).toHaveBeenCalled());
    // Turned off while the segmenter loads: LiveKit destroys the processor the track has, which is none yet.
    stopCamera(camera as never);
    expect(camera.stop).toHaveBeenCalledTimes(1);
    loaded();
    await applying;
    const [processor] = processors.created;
    expect(processor!.destroy).toHaveBeenCalledTimes(1);
    expect(camera.getProcessor()).toBeUndefined();

    // Stopped before the processor's code came in: none is made for it.
    const gone = fakeCamera();
    const late = applyBackground(gone as never, { kind: "blur" });
    stopCamera(gone as never);
    await late;
    expect(gone.setProcessor).not.toHaveBeenCalled();
    expect(processors.created).toHaveLength(1);
  });

  it("takes the files from another base when told", async () => {
    stubBrowser();
    await apply(fakeCamera(), { kind: "blur" }, "https://assets.example/segmenter/");
    expect(processors.created[0]?.options).toMatchObject({
      assetPaths: { tasksVisionFileSet: "https://assets.example/segmenter/wasm", modelAssetPath: "https://assets.example/segmenter/selfie_segmenter.tflite" },
    });
  });

  it("changes nothing where effects are unsupported", async () => {
    const camera = fakeCamera();
    expect(await apply(camera, { kind: "blur" })).toBe(false);
    expect(camera.setProcessor).not.toHaveBeenCalled();
    expect(processors.loaded).toBe(0);
  });

  it("asks the browser once whether it can, and lets its WebGL context go", async () => {
    const browser = stubBrowser();
    const { supportsBackgroundProcessors } = await effects();
    expect([supportsBackgroundProcessors(), supportsBackgroundProcessors(), supportsBackgroundProcessors()]).toEqual([true, true, true]);
    expect(browser.contexts()).toBe(1);
    expect(browser.lost()).toBe(1);
  });
});

describe("the first frames behind a background", () => {
  beforeEach(() => {
    vi.resetModules();
    processors.created.length = 0;
    processors.firstFrameSwitch = true;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const effects = () => import("../src/effects.js");
  const blur = { kind: "blur" } as const;
  /** A picture that does not come until the test lets it. */
  const hold = (camera: ReturnType<typeof fakeCamera>): (() => void) => {
    let give = (): void => undefined;
    camera.picture = new Promise<void>((resolve) => (give = resolve));
    return give;
  };
  /** The processor set and its pipeline running, nothing more to come by itself. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("never carry the camera's first frame unprocessed: the processor starts past it before LiveKit has it", async () => {
    stubBrowser();
    const { applyBackground } = await effects();
    const camera = fakeCamera();
    expect(await applyBackground(camera as never, blur)).toBe(true);
    // Whatever the processed track carried is what a camera published before the background, or after, sends.
    expect(camera.out).toEqual(["processed"]);
  });

  it("are a processed picture before the background counts as on, so nothing goes out before one has come", async () => {
    stubBrowser();
    const { applyBackground } = await effects();
    const camera = fakeCamera();
    const give = hold(camera);
    let on: boolean | null = null;
    const applying = applyBackground(camera as never, blur).then((value) => (on = value));
    await vi.waitFor(() => expect(camera.setProcessor).toHaveBeenCalled());
    await settle();
    expect(on).toBeNull();
    give();
    await applying;
    expect(on).toBe(true);
    expect(camera.out).toEqual(["processed"]);
  });

  it("not come in time leave the background not on: the one the camera had goes back, and a later choice waits for a picture again", async () => {
    stubBrowser();
    const { applyBackground, backgroundOn, FIRST_PICTURE_TIMEOUT_MS } = await effects();
    const camera = fakeCamera();
    const give = hold(camera);
    let loaded = (): void => undefined;
    camera.loading = new Promise((resolve) => (loaded = resolve));
    const failing = expect(applyBackground(camera as never, blur)).rejects.toThrow(/no picture/);
    // The processor's code in on real timers (the module loader runs on them), then the clock is the test's.
    await vi.waitFor(() => expect(camera.setProcessor).toHaveBeenCalled());
    vi.useFakeTimers();
    loaded();
    await vi.advanceTimersByTimeAsync(FIRST_PICTURE_TIMEOUT_MS);
    await failing;
    expect(showing(camera)).toEqual({ mode: "none" });
    expect(backgroundOn(camera as never)).toEqual({ kind: "none" });

    // The same processor, still without a picture: chosen again, it is on only once one comes.
    let on: boolean | null = null;
    const again = applyBackground(camera as never, blur).then((value) => (on = value));
    await vi.advanceTimersByTimeAsync(FIRST_PICTURE_TIMEOUT_MS - 1);
    expect(on).toBeNull();
    give();
    await vi.advanceTimersByTimeAsync(0);
    await again;
    expect(on).toBe(true);
    expect(camera.out).toEqual(["processed"]);
  });

  it("waited on are let go for a later choice, and for the camera stopped for good", async () => {
    stubBrowser();
    const { applyBackground, stopCamera } = await effects();
    const camera = fakeCamera();
    hold(camera);
    const first = applyBackground(camera as never, blur);
    await vi.waitFor(() => expect(camera.setProcessor).toHaveBeenCalled());
    await settle();
    // None, chosen while the blur waits on its picture: the blur is let go, None answers at once.
    expect(await Promise.all([first, applyBackground(camera as never, { kind: "none" })])).toEqual([true, true]);
    expect(showing(camera)).toEqual({ mode: "none" });

    const other = fakeCamera();
    hold(other);
    const waiting = applyBackground(other as never, blur);
    await vi.waitFor(() => expect(other.setProcessor).toHaveBeenCalled());
    await settle();
    stopCamera(other as never);
    await expect(waiting).resolves.toBe(true);
    expect(other.out).toEqual([]);
  });

  it("are never left to a processor that cannot be kept from passing its first frame: it is refused, nothing put on the camera", async () => {
    stubBrowser();
    processors.firstFrameSwitch = false;
    const { applyBackground, backgroundOn } = await effects();
    const camera = fakeCamera();
    await expect(applyBackground(camera as never, blur)).rejects.toThrow(/first frame/);
    expect(camera.setProcessor).not.toHaveBeenCalled();
    expect(camera.out).toEqual([]);
    expect(backgroundOn(camera as never)).toEqual({ kind: "none" });
  });
});
