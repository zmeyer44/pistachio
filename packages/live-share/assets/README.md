# Camera background assets

What the live share's camera backgrounds (`src/effects.ts`, docs/live-share.md §1) load at run time, served from each site's own origin at `/live/mediapipe/` — never from a CDN. `index.mjs` lists them and copies them; www copies them into `public/live/mediapipe/` from `next.config.js`, and the desktop's renderer build emits them beside the live-host page (`electron.vite.config.ts`).

## `selfie_segmenter.tflite` (vendored here)

MediaPipe's Selfie Segmenter, the general (square, 256×256 input) model, float16 — the model `@livekit/track-processors` would otherwise fetch from Google's storage.

- Source: <https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite> (version `1`; byte-identical to `…/float16/latest/…` when fetched on 2026-10-17, last modified 2023-05-07).
- Size: 249,537 bytes. SHA-256: `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b` (`test/effects.test.ts` holds it).
- Licence: Apache License, Version 2.0, per Google's model card, "Model Card: MediaPipe Selfie Segmentation" (<https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf>; authors Tingbo Hou, Siargey Pisarchyk, Karthik Raveendran, Google; dated May 6, 2021).
- Listed in MediaPipe's image segmenter docs: <https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter#selfie-model>.

To update it, fetch a newer numbered version from the same folder, check the model card's licence, and update the hash here and in the test.

## MediaPipe's WASM (not vendored)

`vision_wasm_internal.{js,wasm}` (and the `nosimd` build, for www only) come from the `@mediapipe/tasks-vision` package that `@livekit/track-processors` depends on (Apache-2.0), resolved from its location in `node_modules` at build and dev time, so they always match the MediaPipe JavaScript bundled into the page. They are never committed: www's copy is gitignored, the desktop's lives only in `out/`.
