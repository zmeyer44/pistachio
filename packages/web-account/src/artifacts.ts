import type { ArtifactRecord } from "@pistachio/sync-protocol";
import type { HostedArtifact } from "./control";

export type ArtifactHostingById = ReadonlyMap<string, HostedArtifact>;

export const ARTIFACT_DOCUMENT_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** CSP for srcDoc; the iframe's sandbox attribute supplies the opaque origin. */
const ARTIFACT_META_CSP = ARTIFACT_DOCUMENT_CSP
  .split("; ")
  .filter((directive) => !directive.startsWith("sandbox ") && !directive.startsWith("frame-ancestors "))
  .join("; ");

/** Insert policy before any authored content can execute. */
export function isolatedArtifactDocument(artifact: Pick<ArtifactRecord, "html">): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_META_CSP}"><meta name="referrer" content="no-referrer">`;
  return /<head(?:\s[^>]*)?>/iu.test(artifact.html)
    ? artifact.html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${meta}`)
    : `<!doctype html><html><head>${meta}</head><body>${artifact.html}</body></html>`;
}

export function publicArtifactPath(hosting: Pick<HostedArtifact, "shareId">): string {
  return `/artifacts/${hosting.shareId}`;
}
