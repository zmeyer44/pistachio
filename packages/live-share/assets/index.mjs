/**
 * The camera backgrounds' segmenter files (docs/live-share.md §1), for the
 * servers that serve them: www copies them under its `public/`, the desktop's
 * renderer build emits them beside the live-host page. Both put them at
 * `EFFECTS_ASSET_DIR`, the path `src/effects.ts` loads them from on the
 * page's own origin — nothing comes from a CDN.
 *
 * The WASM is MediaPipe's own, from `@mediapipe/tasks-vision` exactly as
 * `@livekit/track-processors` resolves it: the page bundles that package's
 * JavaScript, and the two must be the same version. The model is vendored
 * beside this file (README.md: its source, version and licence).
 *
 * Node only.
 */

import { copyFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the files go under a site's root (`effects.ts` EFFECTS_ASSET_PATH is `/` + this). */
export const EFFECTS_ASSET_DIR = "live/mediapipe";

const MODEL = "selfie_segmenter.tflite";

/** MediaPipe's loaders and WASM: SIMD first, and the build for engines without it. */
const WASM_BUILDS = ["vision_wasm_internal", "vision_wasm_nosimd_internal"];

/** The `wasm/` folder of the `@mediapipe/tasks-vision` that `@livekit/track-processors` imports. */
function tasksVisionWasmDir() {
  const processors = createRequire(import.meta.url).resolve("@livekit/track-processors/package.json");
  // (Its exports name no package.json: its entry is enough to find the folder.)
  const entry = createRequire(processors).resolve("@mediapipe/tasks-vision");
  return join(dirname(entry), "wasm");
}

/**
 * Every file, as `{ path, source }`: `path` under the asset base, `source`
 * absolute on disk. `simdFallback: false` leaves out MediaPipe's build for
 * engines without WebAssembly SIMD, which no Chromium the desktop ships lacks
 * (MediaPipe picks the SIMD build wherever SIMD validates).
 */
export function effectsAssets({ simdFallback = true } = {}) {
  const wasm = tasksVisionWasmDir();
  const builds = simdFallback ? WASM_BUILDS : WASM_BUILDS.slice(0, 1);
  return [
    ...builds.flatMap((build) => [`${build}.js`, `${build}.wasm`].map((file) => ({ path: `wasm/${file}`, source: join(wasm, file) }))),
    { path: MODEL, source: fileURLToPath(new URL(MODEL, import.meta.url)) },
  ];
}

/**
 * Copy them under `dir` (`<dir>/wasm/…`, `<dir>/selfie_segmenter.tflite`).
 * A copy keeps its source's modification time, so a file already copied is
 * left alone and a changed one (a new MediaPipe) is copied again.
 */
export function copyEffectsAssets(dir, options) {
  for (const { path, source } of effectsAssets(options)) {
    const target = join(dir, path);
    const from = statSync(source);
    if (sameAs(target, from)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    utimesSync(target, from.atime, from.mtime);
  }
}

function sameAs(target, source) {
  try {
    const stat = statSync(target);
    return stat.size === source.size && stat.mtimeMs === source.mtimeMs;
  } catch {
    return false;
  }
}
