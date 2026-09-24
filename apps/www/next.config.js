/* global process */

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // Browser tests use a private build directory so they can run alongside a
  // developer's live Next process without contending for `.next/dev/lock`.
  distDir: process.env["PISTACHIO_NEXT_DIST_DIR"] ?? ".next",
  async headers() {
    return [
      {
        source: "/credential-capture/:captureId",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Content-Security-Policy", value: "base-uri 'none'; form-action 'self'; frame-ancestors 'none'" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/onboarding/imessage",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Content-Security-Policy", value: "base-uri 'none'; form-action 'self'; frame-ancestors 'none'" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  // Workspace packages ship TypeScript source, not a build.
  transpilePackages: [
    "@pistachio/agent-runtime",
    "@pistachio/evidence",
    "@pistachio/live-view",
    "@pistachio/notes",
    "@pistachio/protocol",
    "@pistachio/reports",
    "@pistachio/run-view",
    "@pistachio/shell-contracts",
    "@pistachio/shell-ui",
    "@pistachio/sync-engine",
    "@pistachio/sync-protocol",
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
