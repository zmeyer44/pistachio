/**
 * The current desktop release advertised on /download. Update this alongside
 * apps/desktop/package.json when a new build is published; the hash and size
 * come from the signed, notarized DMG that was uploaded.
 */
export const release = {
  version: "0.0.44",
  channel: "Early preview",
  publishedAt: "2026-10-15",
  platform: "macOS",
  arch: "Apple silicon",
  minimumOs: "macOS 12 Monterey",
  file: "Pistachio-0.0.44-arm64.dmg",
  bytes: 153_976_390,
  sha256: "bc5fb055b9279edc0ceaf4e3aa8688cabc4fc8cee4f4a5061365e6f6a0e7d7f2",
} as const;

/** Public R2 bucket (harbor-public) where release DMGs are uploaded. */
const RELEASES_BASE_URL =
  "https://pub-68b47b2a682a4b2f8b6bb9a2df285ec5.r2.dev/releases";

/**
 * Where the DMG lives. NEXT_PUBLIC_PISTACHIO_DOWNLOAD_URL overrides the
 * default for previews or a future custom domain.
 */
export const downloadUrl =
  process.env["NEXT_PUBLIC_PISTACHIO_DOWNLOAD_URL"] ??
  `${RELEASES_BASE_URL}/${release.file}`;

export function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}
