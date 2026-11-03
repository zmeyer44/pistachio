# Recorder

The first extension in Pistachio's library (docs/recorder.md, docs/extensions.md §9): a screen recorder in the style of screen.studio for a desk window, built only on the public `pistachio.*` API.

- `pistachio.json` — the manifest; `build.json` — what `apps/desktop/scripts/build-extensions.mjs` bundles into `out/extensions/com.pistachio.recorder/`.
- `worker.ts` → `src/engine/` — the engine (capture, encode, events, the status pill).
- `panel.html` + `src/panel/` — the Ledge's panel (source, mic, camera, Record; Recent).
- `editor.html` + `src/editor/` — the editor (preview, timeline, inspector, export sheet).
- `src/lib/` — the pure solvers and the renderer (`types.ts` is the contract between every part).
- `src/export/` — the export Worker (mediabunny, gifenc).
- `test/` — vitest: `pnpm --filter @pistachio/desktop test:recorder`; types: `pnpm --filter @pistachio/desktop check-types:recorder`.
