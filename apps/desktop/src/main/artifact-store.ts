/**
 * The artifact library: metadata in `<userData>/artifacts.json` — read
 * once, rewritten whole on every change, the way settings, memory, and
 * reminders are kept — and each page's HTML as its own file in
 * `<userData>/artifacts/<id>.html`, read per request rather than held in
 * memory, because a page can be a megabyte where a reminder is a line.
 *
 * The store also answers the pistachio protocol for its addresses:
 * `pistachio://artifact/<id>` is the page itself and `pistachio://artifacts`
 * is the library's index. Pages are served under a strict
 * Content-Security-Policy — everything inline, no external resources,
 * scripts, fetches, or form posts — so a page
 * built by a model that read untrusted web content cannot phone home.
 * `standard: true` on the scheme means each host is its own origin, so an
 * artifact shares nothing with the welcome or demo pages.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_HOST,
  artifactUrl,
  isArtifactId,
  MAX_ARTIFACT_BRIEF,
  MAX_ARTIFACT_HTML_BYTES,
  MAX_ARTIFACT_TITLE,
  MAX_ARTIFACTS,
  sanitizeArtifactDocument,
  type Artifact,
  type ArtifactDocument,
  type ArtifactSource,
} from "@pistachio/shell-contracts/artifacts";
import type { ArtifactRecord } from "@pistachio/sync-protocol";

export interface ArtifactCreateInput {
  title: string;
  brief: string;
  html: string;
  builtWith: string;
}

export interface ArtifactUpdateInput {
  title?: string;
  brief?: string;
  html: string;
  builtWith: string;
}

/**
 * What an artifact page may do, and nothing more. Scripts and styles are
 * inline by construction (the builder is told so and external loads are
 * blocked here); data/blob media can render without creating an exfiltration
 * channel. `connect-src 'none'` and `form-action 'none'` keep anything the
 * page carries from leaving.
 */
const ARTIFACT_CSP = [
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
].join("; ");

function page(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // An updated artifact must show fresh on the next load or reload.
      "cache-control": "no-store",
      "content-security-policy": ARTIFACT_CSP,
      "x-content-type-options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export class ArtifactStore {
  readonly #path: string;
  readonly #dir: string;
  readonly #now: () => Date;
  /** The account's web origin, or null when this Mac has no account to render on. */
  readonly #webUrl: () => string | null;
  readonly #recordListeners = new Set<(id: string) => void>();
  #artifacts: Artifact[];

  constructor(userDataDir: string, options: { now?: () => Date; webUrl?: () => string | null } = {}) {
    this.#path = join(userDataDir, "artifacts.json");
    this.#dir = join(userDataDir, "artifacts");
    this.#now = options.now ?? (() => new Date());
    this.#webUrl = options.webUrl ?? (() => null);
    this.#artifacts = this.#read().artifacts;
  }

  /**
   * Where the index links each artifact. The web app renders an artifact out
   * of the signed-in account's sync session, so without an account — or on a
   * control that is not production — the link has to be this Mac's own copy,
   * which `respond()` serves. Never the hardcoded production origin.
   */
  #link(id: string): string {
    const web = this.#webUrl();
    return web === null || web === "" ? `pistachio://${ARTIFACT_HOST}/${id}` : artifactUrl(id, web);
  }

  /** Every artifact, the most recently touched first. */
  all(): Artifact[] {
    return [...this.#artifacts]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((artifact) => structuredClone(artifact));
  }

  get(id: string): Artifact | null {
    const found = this.#artifacts.find((artifact) => artifact.id === id);
    return found === undefined ? null : structuredClone(found);
  }

  /** Complete encrypted-sync records: metadata and the page it names. */
  syncAll(): ArtifactRecord[] {
    return this.all().flatMap((artifact) => {
      const html = this.html(artifact.id);
      return html === null ? [] : [{ ...artifact, html }];
    });
  }

  syncGet(id: string): ArtifactRecord | null {
    const artifact = this.get(id);
    const html = this.html(id);
    return artifact === null || html === null ? null : { ...artifact, html };
  }

  /** The page's HTML off disk, or null when the id or its file is gone. */
  html(id: string): string | null {
    if (!isArtifactId(id) || this.get(id) === null) return null;
    try {
      return readFileSync(join(this.#dir, `${id}.html`), "utf8");
    } catch {
      return null;
    }
  }

  create(input: ArtifactCreateInput, source: ArtifactSource): Artifact {
    if (this.#artifacts.length >= MAX_ARTIFACTS) {
      throw new Error(`the library already holds ${String(MAX_ARTIFACTS)} artifacts; update an existing one instead of creating another`);
    }
    const at = this.#now().toISOString();
    const artifact: Artifact = {
      id: this.#freshId(),
      title: this.#title(input.title),
      brief: this.#brief(input.brief),
      createdAt: at,
      updatedAt: at,
      revision: 1,
      builtWith: input.builtWith,
      source: { ...source },
    };
    this.#writeHtml(artifact.id, input.html);
    this.#artifacts.push(artifact);
    this.#write();
    this.#notifyRecord(artifact.id);
    return structuredClone(artifact);
  }

  update(id: string, input: ArtifactUpdateInput, source: ArtifactSource): Artifact {
    const artifact = this.#artifacts.find((entry) => entry.id === id);
    if (artifact === undefined) throw new Error(`no artifact ${id}`);
    this.#writeHtml(id, input.html);
    if (input.title !== undefined) artifact.title = this.#title(input.title);
    if (input.brief !== undefined) artifact.brief = this.#brief(input.brief);
    artifact.updatedAt = this.#now().toISOString();
    artifact.revision += 1;
    artifact.builtWith = input.builtWith;
    artifact.source = { ...source };
    this.#write();
    this.#notifyRecord(artifact.id);
    return structuredClone(artifact);
  }

  onRecordChange(listener: (id: string) => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  /** Apply a whole encrypted record received from another device. */
  applyRemote(value: unknown): ArtifactRecord | null {
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw["html"] !== "string") return null;
    const parsed = sanitizeArtifactDocument({ version: 1, artifacts: [raw] }).artifacts[0];
    if (parsed === undefined) return null;
    try {
      this.#writeHtml(parsed.id, raw["html"]);
    } catch {
      return null;
    }
    const index = this.#artifacts.findIndex((candidate) => candidate.id === parsed.id);
    if (index === -1) this.#artifacts.push(parsed);
    else this.#artifacts[index] = parsed;
    this.#write();
    return { ...structuredClone(parsed), html: raw["html"] };
  }

  removeRemote(id: string): boolean {
    const before = this.#artifacts.length;
    this.#artifacts = this.#artifacts.filter((artifact) => artifact.id !== id);
    if (before === this.#artifacts.length) return false;
    try {
      rmSync(join(this.#dir, `${id}.html`), { force: true });
    } catch {
      // The metadata is authoritative; a stray missing page is harmless.
    }
    this.#write();
    return true;
  }

  /** The protocol's answer for this store's hosts, or null for any other. */
  respond(url: URL): Response | null {
    if (url.host === "artifacts" && (url.pathname === "/" || url.pathname === "")) {
      return page(this.#indexHtml());
    }
    if (url.host !== ARTIFACT_HOST) return null;
    const id = url.pathname.replace(/^\//, "");
    const html = this.html(id);
    if (html === null) return new Response("Not found", { status: 404 });
    return page(html);
  }

  #title(value: string): string {
    const title = value.trim();
    if (title === "" || title.length > MAX_ARTIFACT_TITLE) throw new Error(`an artifact title is 1–${String(MAX_ARTIFACT_TITLE)} characters`);
    return title;
  }

  #brief(value: string): string {
    const brief = value.trim();
    if (brief.length > MAX_ARTIFACT_BRIEF) throw new Error(`an artifact brief is at most ${String(MAX_ARTIFACT_BRIEF)} characters`);
    return brief;
  }

  #freshId(): string {
    for (;;) {
      const id = randomBytes(6).toString("hex");
      if (!this.#artifacts.some((artifact) => artifact.id === id)) return id;
    }
  }

  #writeHtml(id: string, html: string): void {
    const bytes = Buffer.byteLength(html, "utf8");
    if (html.trim() === "") throw new Error("an artifact needs a document");
    if (bytes > MAX_ARTIFACT_HTML_BYTES) {
      throw new Error(`the document is ${String(bytes)} bytes; an artifact holds at most ${String(MAX_ARTIFACT_HTML_BYTES)}`);
    }
    mkdirSync(this.#dir, { recursive: true });
    const path = join(this.#dir, `${id}.html`);
    writeFileSync(`${path}.tmp`, html, "utf8");
    renameSync(`${path}.tmp`, path);
  }

  #read(): ArtifactDocument {
    try {
      return sanitizeArtifactDocument(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return { version: 1, artifacts: [] };
    }
  }

  #write(): void {
    const document: ArtifactDocument = { version: 1, artifacts: this.#artifacts };
    writeFileSync(`${this.#path}.tmp`, JSON.stringify(document, null, 2), "utf8");
    renameSync(`${this.#path}.tmp`, this.#path);
  }

  #notifyRecord(id: string): void {
    for (const listener of this.#recordListeners) listener(id);
  }

  /** The library's own page: every artifact as a link, newest first. */
  #indexHtml(): string {
    const rows = this.all()
      .map((artifact) => {
        const when = new Date(artifact.updatedAt).toLocaleString();
        return `<li><a href="${this.#link(artifact.id)}">${escapeHtml(artifact.title)}</a><span>updated ${escapeHtml(when)} · revision ${String(artifact.revision)}</span></li>`;
      })
      .join("\n");
    const body = rows === "" ? `<p class="empty">Nothing here yet. Ask the agent to build you a page.</p>` : `<ul>${rows}</ul>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacts</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 40rem; padding: 3rem 1.5rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.75rem 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
a { color: inherit; font-weight: 600; text-decoration: none; }
a:hover { text-decoration: underline; }
li span, .empty { font-size: 0.8rem; color: color-mix(in srgb, CanvasText 55%, transparent); }
</style>
</head>
<body>
<h1>Artifacts</h1>
${body}
</body>
</html>`;
  }
}

/**
 * The store main registered at startup, for the protocol handlers — the
 * chrome window's in index.ts and each space session's in
 * browser-controller.ts — the way welcome-pages hands out its context.
 */
let registered: ArtifactStore | null = null;

export function setArtifactStore(store: ArtifactStore | null): void {
  registered = store;
}

export function artifactResponse(url: URL): Response | null {
  return registered?.respond(url) ?? null;
}
