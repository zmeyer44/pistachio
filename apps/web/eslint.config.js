import { nextJsConfig } from "@repo/eslint-config/next-js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  {
    /*
     * The web e2e specs build into a private dist directory
     * (`PISTACHIO_NEXT_DIST_DIR`), so a run that was killed before its
     * `finally` leaves one behind. It is build output either way.
     */
    ignores: [".next-e2e-*/**"],
  },
  {
    files: ["components/streamed-pane.tsx"],
    rules: {
      /*
       * A pane is a live screencast: each frame is an object URL this
       * component creates and revokes itself, at the pane's exact device
       * pixel size (docs/web-browser-design.md §7). next/image optimises
       * static assets it can fetch and resize, which is the opposite of
       * every property this element has.
       */
      "@next/next/no-img-element": "off",
    },
  },
];
