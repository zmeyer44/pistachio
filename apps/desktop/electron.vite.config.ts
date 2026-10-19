import { createReadStream, readFileSync } from "node:fs";
import { extname } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { EFFECTS_ASSET_DIR, effectsAssets } from "@pistachio/live-share/assets";

const workspacePackages = [
  "@pistachio/dom-mirror",
  "@pistachio/watchtower",
  "@pistachio/reports",
  "@pistachio/adapters",
  "@pistachio/agent-runtime",
  "@pistachio/documents",
  "@pistachio/egress-policy",
  "@pistachio/evidence",
  // Value-imported by main (cloud/live-view-client.ts) and published as raw
  // TypeScript, so a packaged build that externalized it would ask Electron
  // to load a .ts file out of app.asar.
  "@pistachio/live-view",
  // Value-imported by main (live/, docs/live-share.md §6.1), raw TypeScript as live-view is.
  "@pistachio/live-share",
  "@pistachio/notes",
  "@pistachio/notifications",
  "@pistachio/policy",
  "@pistachio/protocol",
  "@pistachio/runtime",
  "@pistachio/shell-contracts",
  "@pistachio/shell-ui",
  "@pistachio/smart-find",
  "@pistachio/sync-engine",
  "@pistachio/sync-protocol",
];

const ASSET_TYPES: Readonly<Record<string, string>> = { ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };

/**
 * The live share's camera backgrounds (docs/live-share.md §1): the live-host
 * page loads MediaPipe's segmenter — its WASM and model — from its own origin
 * (`@pistachio/live-share/effects`), so the renderer serves them there in
 * dev and emits them beside the page in a build (out/renderer/live/mediapipe/,
 * which electron-builder packs with the rest of out/). Only the SIMD build:
 * Electron's Chromium always has WebAssembly SIMD.
 */
function liveEffectsAssets(): Plugin {
  const assets = effectsAssets({ simdFallback: false });
  const prefix = `/${EFFECTS_ASSET_DIR}/`;
  return {
    name: "pistachio-live-effects-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        const asset = path.startsWith(prefix) ? assets.find((candidate) => candidate.path === path.slice(prefix.length)) : undefined;
        if (asset === undefined) {
          next();
          return;
        }
        response.setHeader("content-type", ASSET_TYPES[extname(asset.path)] ?? "application/octet-stream");
        createReadStream(asset.source).pipe(response);
      });
    },
    generateBundle() {
      for (const asset of assets) this.emitFile({ type: "asset", fileName: `${EFFECTS_ASSET_DIR}/${asset.path}`, source: readFileSync(asset.source) });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: {
          index: "src/main/index.ts",
          "watchtower-worker": "src/main/watchtower/worker.ts",
          "shields-worker": "src/main/shields/compile-worker.ts",
          // The terminals' shells (docs/terminal.md §3): node-pty, in a utility process of its own.
          "terminal-host": "src/main/terminal/host.ts",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: {
          index: "src/preload/index.ts",
          tab: "src/preload/tab.ts",
          "auth-popup": "src/preload/auth-popup.ts",
          // The live share's room window (docs/live-share.md §10): sandboxed, its own members alone.
          "live-host": "src/preload/live-host.ts",
        },
        // Sandboxed WebContentsViews only run CommonJS preloads. The trusted
        // shell preload works in the same format, which lets both entries be
        // emitted by electron-vite's single preload build.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    // Shared capture UI uses the account's controlUrl; keep its browser
    // client's optional Next build setting safe to import in Electron too.
    define: { "process.env.NEXT_PUBLIC_PISTACHIO_CONTROL_URL": "undefined" },
    plugins: [react(), tailwindcss(), liveEffectsAssets()],
    optimizeDeps: {
      entries: ["src/renderer/index.html"],
      // The note editor is a lazy chunk (docs/notes.md §4), so the dev server
      // only meets these on the first ⌘⌥N — and answers by optimizing them
      // and reloading the whole shell mid-keystroke. Named here, they are
      // ready before the window opens. They are shell-ui's dependencies, hence
      // the nested form. The desk's tooltip is the same case: met on the first
      // visit to the desk.
      include: [
        "@pistachio/shell-ui > @tiptap/core",
        "@pistachio/shell-ui > @tiptap/react",
        "@pistachio/shell-ui > @tiptap/pm/state",
        "@pistachio/shell-ui > @tiptap/starter-kit",
        "@pistachio/shell-ui > @tiptap/markdown",
        "@pistachio/shell-ui > @tiptap/suggestion",
        "@pistachio/shell-ui > @tiptap/extension-placeholder",
        "@pistachio/shell-ui > @tiptap/extension-image",
        "@pistachio/shell-ui > @tiptap/extension-link",
        "@pistachio/shell-ui > @tiptap/extension-task-list",
        "@pistachio/shell-ui > @tiptap/extension-task-item",
        "@pistachio/shell-ui > @tiptap/extension-table",
        "@pistachio/shell-ui > @tiptap/extension-drag-handle-react",
        "@pistachio/shell-ui > @floating-ui/react",
        "@pistachio/shell-ui > @base-ui/react/tooltip",
      ],
    },
    build: {
      rollupOptions: {
        // The live share's room is a page of its own: its policy lets it compile WebAssembly (live-host.html).
        input: { index: "src/renderer/index.html", "live-host": "src/renderer/live-host.html" },
        output: {
          // React in its own chunk: it changes only when the dependency does,
          // so it stays cached across releases, and the lazy view chunks
          // (renderer/src/main.tsx) share one copy of it.
          manualChunks(id) {
            return /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? "vendor" : undefined;
          },
        },
      },
    },
  },
});
