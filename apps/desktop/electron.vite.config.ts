import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const workspacePackages = [
  "@pistachio/dom-mirror",
  "@pistachio/watchtower",
  "@pistachio/reports",
  "@pistachio/adapters",
  "@pistachio/agent-runtime",
  "@pistachio/egress-policy",
  "@pistachio/evidence",
  // Value-imported by main (cloud/live-view-client.ts) and published as raw
  // TypeScript, so a packaged build that externalized it would ask Electron
  // to load a .ts file out of app.asar.
  "@pistachio/live-view",
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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: { rollupOptions: { input: { index: "src/main/index.ts", "watchtower-worker": "src/main/watchtower/worker.ts" } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: {
          index: "src/preload/index.ts",
          tab: "src/preload/tab.ts",
          "auth-popup": "src/preload/auth-popup.ts",
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
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      entries: ["src/renderer/index.html"],
      // The note editor is a lazy chunk (docs/notes.md §4), so the dev server
      // only meets these on the first ⌘⌥N — and answers by optimizing them
      // and reloading the whole shell mid-keystroke. Named here, they are
      // ready before the window opens. They are shell-ui's dependencies, hence
      // the nested form.
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
      ],
    },
    build: {
      rollupOptions: {
        input: { index: "src/renderer/index.html" },
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
