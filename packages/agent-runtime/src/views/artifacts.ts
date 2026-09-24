/**
 * Artifacts: complete HTML pages the agent builds for the person — a
 * morning news feed, a trip itinerary, a small site — each kept at a
 * stable web-app address that opens on any signed-in device. The address
 * never changes across updates, so a recurring
 * deliverable is one pinnable page whose content refreshes, not a new
 * page every morning.
 *
 * This module is the pure core shared by main and tests: the shapes, the
 * caps, the address, and the readers over model output and the file on
 * disk. The store (main/artifact-store.ts) owns persistence and serving;
 * the builder (main/artifact-builder.ts) owns the model that writes HTML.
 */

/** Who commissioned the current revision, for the record and the evidence chain. */
export interface ArtifactSource {
  kind: "user" | "agent";
  runId: string | null;
}

export interface Artifact {
  /** Twelve hex characters; the path of the page's address. */
  id: string;
  title: string;
  /** What the page is for, in the words used to commission it. */
  brief: string;
  createdAt: string;
  updatedAt: string;
  /** Counts builds: 1 when created, one more per update. */
  revision: number;
  /** The model that wrote the current HTML. */
  builtWith: string;
  source: ArtifactSource;
}

export interface ArtifactDocument {
  version: 1;
  artifacts: Artifact[];
}

/** What the agent's tools see and return: enough to link, list, and update. */
export interface ArtifactToolView {
  id: string;
  url: string;
  title: string;
  brief: string;
  updatedAt: string;
  revision: number;
}

export const ARTIFACT_HOST = "artifact";
export const ARTIFACTS_INDEX_URL = "pistachio://artifacts";
export const DEFAULT_ARTIFACT_WEB_URL = "https://pistachio.run";
export const MAX_ARTIFACTS = 100;
export const MAX_ARTIFACT_HTML_BYTES = 1_500_000;
export const MAX_ARTIFACT_TITLE = 120;
export const MAX_ARTIFACT_BRIEF = 2_000;

export function artifactUrl(id: string, webBaseUrl = DEFAULT_ARTIFACT_WEB_URL): string {
  return `${webBaseUrl.replace(/\/+$/u, "")}/app/artifacts/${id}`;
}

const ID_RE = /^[a-f0-9]{12}$/;

export function isArtifactId(value: string): boolean {
  return ID_RE.test(value);
}

export function artifactToolView(artifact: Artifact, webBaseUrl?: string): ArtifactToolView {
  return {
    id: artifact.id,
    url: artifactUrl(artifact.id, webBaseUrl),
    title: artifact.title,
    brief: artifact.brief,
    updatedAt: artifact.updatedAt,
    revision: artifact.revision,
  };
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function sanitizeSource(value: unknown): ArtifactSource | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as { kind?: unknown; runId?: unknown };
  if (source.kind !== "user" && source.kind !== "agent") return null;
  if (source.runId !== null && typeof source.runId !== "string") return null;
  return { kind: source.kind, runId: source.runId ?? null };
}

function sanitizeArtifact(value: unknown): Artifact | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const source = sanitizeSource(raw["source"]);
  if (
    typeof raw["id"] !== "string" || !isArtifactId(raw["id"]) ||
    typeof raw["title"] !== "string" || raw["title"] === "" || raw["title"].length > MAX_ARTIFACT_TITLE ||
    typeof raw["brief"] !== "string" || raw["brief"].length > MAX_ARTIFACT_BRIEF ||
    !isIsoInstant(raw["createdAt"]) || !isIsoInstant(raw["updatedAt"]) ||
    typeof raw["revision"] !== "number" || !Number.isInteger(raw["revision"]) || raw["revision"] < 1 ||
    typeof raw["builtWith"] !== "string" ||
    source === null
  ) {
    return null;
  }
  return {
    id: raw["id"],
    title: raw["title"],
    brief: raw["brief"],
    createdAt: raw["createdAt"],
    updatedAt: raw["updatedAt"],
    revision: raw["revision"],
    builtWith: raw["builtWith"],
    source,
  };
}

/**
 * The artifacts file as trustworthy state: entries that do not parse are
 * dropped rather than crashing the store, the way the other stores read
 * their files, and duplicate ids keep their first appearance.
 */
export function sanitizeArtifactDocument(value: unknown): ArtifactDocument {
  const empty: ArtifactDocument = { version: 1, artifacts: [] };
  if (typeof value !== "object" || value === null) return empty;
  const raw = value as { version?: unknown; artifacts?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.artifacts)) return empty;
  const seen = new Set<string>();
  const artifacts: Artifact[] = [];
  for (const entry of raw.artifacts) {
    const artifact = sanitizeArtifact(entry);
    if (artifact === null || seen.has(artifact.id)) continue;
    seen.add(artifact.id);
    artifacts.push(artifact);
  }
  return { version: 1, artifacts };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The document out of a model's answer. Builders are told to answer with
 * bare HTML, but a model may still fence it or preface it with a word of
 * prose, so this reads from the first document opener to the last close
 * tag; a bare fragment is wrapped in a minimal document rather than
 * refused. Only an answer with no markup at all is an error.
 */
export function extractArtifactHtml(raw: string, title: string): string {
  let text = raw.trim();
  const fenced = /^```[a-z]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  const opener = /<!doctype\s|<html[\s>]/i.exec(text);
  if (opener !== null) {
    const close = text.toLowerCase().lastIndexOf("</html>");
    return close === -1 ? text.slice(opener.index) : text.slice(opener.index, close + "</html>".length);
  }
  if (!/<[a-z][\s\S]*>/i.test(text)) throw new Error("the builder's answer contained no HTML");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n</head>\n<body>\n${text}\n</body>\n</html>`;
}
