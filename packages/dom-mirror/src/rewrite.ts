/**
 * Turning the URLs a document names into asset tokens (docs/web-browser-design.md §16.3).
 *
 * A mirrored document must not fetch anything itself: the image may need the
 * cloud browser's cookies, the font its referer, the stylesheet a signed URL,
 * and the renderer's document is behind a CSP that refuses the network
 * outright. So before a snapshot or a patch leaves the worker, every URL that
 * names bytes is resolved against the frame's base, handed to the session's
 * asset broker, and replaced by `pa-asset:<id>`. The renderer turns the token
 * into a `blob:` URL once the bytes arrive.
 *
 * Everything here is pure and runs on the host: the recorder inside the page
 * sends raw attributes and raw CSS, because the page must not learn the
 * broker's ids, and the renderer only ever sees tokens.
 */

import type { MirrorElement, MirrorNode, MirrorOp } from "./protocol.js";
import { MAX_URL_LENGTH } from "./protocol.js";

/** Given an absolute URL, the token to put in its place, or null to leave it. */
export type UrlResolver = (url: string, context: AssetContext) => string | null;

export type AssetContext = "image" | "font" | "style" | "media" | "other";

/** Attributes that name bytes the renderer will need, by element. */
const URL_ATTRIBUTES: Record<string, Record<string, AssetContext>> = {
  link: { href: "style" },
  img: { src: "image" },
  input: { src: "image" },
  video: { poster: "image" },
  image: { href: "image", "xlink:href": "image" },
  use: { href: "image", "xlink:href": "image" },
  feimage: { href: "image", "xlink:href": "image" },
  source: { src: "media" },
  track: { src: "other" },
};

/**
 * Whether a URL is one the broker can fetch. `data:` is self-contained and
 * stays; `about:`, `javascript:`, `#fragment`, and anything unparsable is
 * not an asset and is left for the renderer's sanitizer to refuse.
 */
export function isBrokerable(url: string): boolean {
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  const lower = url.trimStart().toLowerCase();
  return lower.startsWith("http:") || lower.startsWith("https:") || lower.startsWith("blob:");
}

/** Resolve a document URL against its base; null when it cannot be. */
export function absolute(url: string, base: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/* ---------------------------------- CSS ----------------------------------- */

const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)"'\s]*))\s*\)/giu;
const CSS_IMPORT_STRING = /@import\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/giu;

function unescapeCss(value: string): string {
  return value.replace(/\\(.)/gu, "$1");
}

function contextOf(css: string, at: number): AssetContext {
  // The nearest preceding property name says what the URL is for; a font
  // face's `src` and a `background` are fetched the same way but prioritized
  // differently by the broker.
  const before = css.slice(Math.max(0, at - 200), at);
  if (/@font-face[^}]*$/iu.test(before) || /src\s*:\s*[^;]*$/iu.test(before)) return "font";
  if (/@import\s*$/iu.test(before)) return "style";
  return "image";
}

/**
 * Rewrite every `url()` and string-form `@import` in a stylesheet. The base
 * is the sheet's own URL (a `link`) or the document's (a `style`); the
 * resolver answers a token or null to keep the original.
 */
export function rewriteCss(css: string, base: string, resolve: UrlResolver): string {
  const withUrls = css.replace(CSS_URL, (match, dq: string | undefined, sq: string | undefined, bare: string | undefined, at: number) => {
    const raw = dq ?? sq ?? bare ?? "";
    const value = unescapeCss(raw);
    const resolved = absolute(value, base);
    if (resolved === null || !isBrokerable(resolved)) return match;
    const token = resolve(resolved, contextOf(css, at));
    return token === null ? match : `url("${token}")`;
  });
  return withUrls.replace(CSS_IMPORT_STRING, (match, dq: string | undefined, sq: string | undefined) => {
    const value = unescapeCss(dq ?? sq ?? "");
    const resolved = absolute(value, base);
    if (resolved === null || !isBrokerable(resolved)) return match;
    const token = resolve(resolved, "style");
    return token === null ? match : `@import url("${token}")`;
  });
}

/* --------------------------------- srcset --------------------------------- */

export interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

/** Parse `srcset` the permissive way browsers do: comma-separated, descriptor optional. */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  for (const part of value.split(/,(?=\s*\S)/u)) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const space = trimmed.search(/\s/u);
    if (space === -1) out.push({ url: trimmed, descriptor: "" });
    else out.push({ url: trimmed.slice(0, space), descriptor: trimmed.slice(space).trim() });
  }
  return out;
}

export function serializeSrcset(candidates: SrcsetCandidate[]): string {
  return candidates.map((candidate) => (candidate.descriptor === "" ? candidate.url : `${candidate.url} ${candidate.descriptor}`)).join(", ");
}

/* ------------------------------- attributes ------------------------------- */

/**
 * Rewrite the asset-bearing attributes of one element in place. Returns the
 * rewritten map. `style` attributes are treated as CSS; `srcset` per
 * candidate; everything else by the table above.
 */
export function rewriteAttributes(
  tag: string,
  attrs: Record<string, string>,
  base: string,
  resolve: UrlResolver,
): Record<string, string> {
  const out: Record<string, string> = { ...attrs };
  const table = URL_ATTRIBUTES[tag];
  if (table !== undefined) {
    for (const [name, context] of Object.entries(table)) {
      const value = out[name];
      if (value === undefined) continue;
      const resolved = absolute(value, base);
      if (resolved === null || !isBrokerable(resolved)) continue;
      const token = resolve(resolved, context);
      if (token !== null) out[name] = token;
    }
  }
  const srcset = out["srcset"];
  if (srcset !== undefined) {
    out["srcset"] = serializeSrcset(
      parseSrcset(srcset).map((candidate) => {
        const resolved = absolute(candidate.url, base);
        if (resolved === null || !isBrokerable(resolved)) return candidate;
        const token = resolve(resolved, "image");
        return token === null ? candidate : { ...candidate, url: token };
      }),
    );
  }
  const style = out["style"];
  if (style !== undefined && style.includes("url(")) out["style"] = rewriteCss(style, base, resolve);
  return out;
}

/* ---------------------------------- trees --------------------------------- */

/** Rewrite one node and everything under it, including shadow trees and sheets. */
export function rewriteNode(node: MirrorNode, base: string, resolve: UrlResolver): MirrorNode {
  switch (node.t) {
    case "e":
      return rewriteElement(node, base, resolve);
    case "doc":
      return {
        ...node,
        ...(node.adopted === undefined ? {} : { adopted: node.adopted.map((css) => rewriteCss(css, base, resolve)) }),
        c: node.c.map((child) => rewriteNode(child, base, resolve)),
      };
    default:
      return node;
  }
}

function rewriteElement(node: MirrorElement, base: string, resolve: UrlResolver): MirrorElement {
  const out: MirrorElement = { ...node };
  if (node.a !== undefined) out.a = rewriteAttributes(node.tag, node.a, base, resolve);
  if (node.css !== undefined) {
    // A linked sheet's URLs are relative to the sheet, not the document.
    const sheetBase = node.tag === "link" && node.a?.["href"] !== undefined ? (absolute(node.a["href"], base) ?? base) : base;
    out.css = rewriteCss(node.css, sheetBase, resolve);
  }
  if (node.c !== undefined) out.c = node.c.map((child) => rewriteNode(child, base, resolve));
  if (node.sh !== undefined) out.sh = node.sh.map((child) => rewriteNode(child, base, resolve));
  if (node.shs !== undefined) out.shs = node.shs.map((css) => rewriteCss(css, base, resolve));
  return out;
}

/** Rewrite the asset references one patch op carries. */
export function rewriteOp(op: MirrorOp, base: string, resolve: UrlResolver, tagOf: (id: number) => string | null): MirrorOp {
  switch (op.o) {
    case "add":
      return { ...op, n: rewriteNode(op.n, base, resolve) };
    case "attr": {
      if (op.v === null) return op;
      const tag = tagOf(op.id);
      if (tag === null) return op;
      const rewritten = rewriteAttributes(tag, { [op.k]: op.v }, base, resolve);
      return { ...op, v: rewritten[op.k] ?? op.v };
    }
    case "css":
      return { ...op, s: rewriteCss(op.s, base, resolve) };
    case "adopted":
      return { ...op, s: op.s.map((css) => rewriteCss(css, base, resolve)) };
    case "shadow":
      return {
        ...op,
        c: op.c.map((child) => rewriteNode(child, base, resolve)),
        ...(op.s === undefined ? {} : { s: op.s.map((css) => rewriteCss(css, base, resolve)) }),
      };
    default:
      return op;
  }
}

/** Every asset id a rewritten node names, for a sender that wants to prioritize them. */
export function collectAssetIds(node: MirrorNode, into: Set<string> = new Set()): Set<string> {
  const scan = (text: string): void => {
    for (const match of text.matchAll(/pa-asset:([A-Za-z0-9_-]+)/gu)) {
      if (match[1] !== undefined) into.add(match[1]);
    }
  };
  switch (node.t) {
    case "e":
      for (const value of Object.values(node.a ?? {})) scan(value);
      if (node.css !== undefined) scan(node.css);
      for (const css of node.shs ?? []) scan(css);
      for (const child of node.c ?? []) collectAssetIds(child, into);
      for (const child of node.sh ?? []) collectAssetIds(child, into);
      break;
    case "doc":
      for (const css of node.adopted ?? []) scan(css);
      for (const child of node.c) collectAssetIds(child, into);
      break;
    default:
      break;
  }
  return into;
}

export function collectOpAssetIds(op: MirrorOp, into: Set<string> = new Set()): Set<string> {
  const scan = (text: string): void => {
    for (const match of text.matchAll(/pa-asset:([A-Za-z0-9_-]+)/gu)) {
      if (match[1] !== undefined) into.add(match[1]);
    }
  };
  switch (op.o) {
    case "add":
      collectAssetIds(op.n, into);
      break;
    case "attr":
      if (op.v !== null) scan(op.v);
      break;
    case "css":
      scan(op.s);
      break;
    case "adopted":
      for (const css of op.s) scan(css);
      break;
    case "shadow":
      for (const child of op.c) collectAssetIds(child, into);
      for (const css of op.s ?? []) scan(css);
      break;
    default:
      break;
  }
  return into;
}
