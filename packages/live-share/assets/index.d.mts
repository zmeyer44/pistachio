/** Where the files go under a site's root (`effects.ts` EFFECTS_ASSET_PATH is `/` + this). */
export declare const EFFECTS_ASSET_DIR: string;

export interface EffectsAsset {
  /** Under the asset base: `wasm/vision_wasm_internal.wasm`, `selfie_segmenter.tflite`. */
  path: string;
  /** Absolute, on disk. */
  source: string;
}

export interface EffectsAssetOptions {
  /** MediaPipe's build for engines without WebAssembly SIMD (default true; the desktop's Chromium never needs it). */
  simdFallback?: boolean;
}

/** Every file the segmenter loads. */
export declare function effectsAssets(options?: EffectsAssetOptions): EffectsAsset[];

/** Copy them under `dir`, leaving files already copied alone. */
export declare function copyEffectsAssets(dir: string, options?: EffectsAssetOptions): void;
