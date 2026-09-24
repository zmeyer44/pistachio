/* global process */

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // Browser tests use a private build directory so they can run alongside a
  // developer's live Next process without contending for `.next/dev/lock`.
  distDir: process.env["PISTACHIO_NEXT_DIST_DIR"] ?? ".next",
  // Workspace packages ship TypeScript source, not a build.
  transpilePackages: [
    "@pistachio/browser-client",
    "@pistachio/agent-runtime",
    "@pistachio/live-view",
    "@pistachio/notes",
    "@pistachio/protocol",
    "@pistachio/reports",
    "@pistachio/run-view",
    "@pistachio/shell-contracts",
    "@pistachio/shell-ui",
    "@pistachio/sync-protocol",
    "@pistachio/sync-engine",
    "@pistachio/web-account",
  ],
  // Those packages are typechecked under NodeNext, so their relative imports
  // carry the `.js` extension the emitted JS would have. Turbopack does not
  // substitute `.js` for the `.ts` on disk, so this app builds with webpack,
  // which does — see `--webpack` on `dev` and `build`.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
