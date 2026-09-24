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
    rules: {
      /*
       * The landing page ships pre-sized static assets captured from the
       * design it reproduces. Routing them through next/image would re-encode
       * and re-scale them, which changes the rendered pixels, so plain <img>
       * is deliberate here.
       */
      "@next/next/no-img-element": "off",
    },
  },
];
