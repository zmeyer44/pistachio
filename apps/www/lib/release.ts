/**
 * The current desktop release advertised on /download. Update this alongside
 * apps/desktop/package.json when a new build is published; the hash and size
 * come from the signed, notarized DMG that was uploaded.
 */
export const release = {
  version: "0.0.20",
  channel: "Early preview",
  publishedAt: "2026-09-24",
  platform: "macOS",
  arch: "Apple silicon",
  minimumOs: "macOS 12 Monterey",
  file: "Pistachio-0.0.20-arm64.dmg",
  bytes: 130_581_940,
  sha256: "13eca5d6673b8df2acc0d6bc263f3ad2908f754651683275535deff5028776b1",
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
