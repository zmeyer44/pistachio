/**
 * Embed: a sandboxed iframe for a third-party URL (YouTube, Loom, Figma, …).
 *
 * Storage: `<div data-type="embed" data-src="https://…"><iframe …></iframe></div>`.
 * `data-src` keeps the URL the person pasted; the iframe URL is derived from
 * it, so the stored iframe is only a static fallback and is ignored on parse.
 */

import { mergeAttributes, Node } from "@tiptap/core";

export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-presentation allow-forms";
export const EMBED_ALLOW = "fullscreen; picture-in-picture; encrypted-media; clipboard-write";

/**
 * Normalises input to an https URL string, or null when it is not one.
 * A missing scheme is treated as https; any other scheme is rejected.
 */
export function sanitizeEmbedSrc(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:/iu.test(raw) ? raw : `https://${raw.replace(/^\/\//u, "")}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.includes(".")) return null;
  return url.toString();
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/u.test(value)) return Number(value);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/u.exec(value);
  if (!m || !m[0]) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function youTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^(www|m|music)\./u, "");
  if (host === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const m = /^\/(?:embed|shorts|live|v)\/([\w-]+)/u.exec(url.pathname);
  return m?.[1] ?? null;
}

export type EmbedProvider = "YouTube" | "Loom" | "Vimeo" | "Figma" | "Web";

export interface EmbedTarget {
  /** URL to load in the iframe. */
  embedUrl: string;
  provider: EmbedProvider;
}

/** Maps a sanitized https URL to the URL its provider expects inside an iframe. */
export function resolveEmbed(src: string | null | undefined): EmbedTarget | null {
  const safe = sanitizeEmbedSrc(src);
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.replace(/^www\./u, "");

  const ytId = youTubeId(url);
  if (ytId && /^[\w-]{6,}$/u.test(ytId)) {
    const start = parseTimestamp(url.searchParams.get("t") ?? url.searchParams.get("start"));
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${ytId}`);
    if (start) embed.searchParams.set("start", String(start));
    return { embedUrl: embed.toString(), provider: "YouTube" };
  }
  if (host === "loom.com") {
    const m = /^\/(?:share|embed)\/([\da-f]+)/iu.exec(url.pathname);
    if (m) return { embedUrl: `https://www.loom.com/embed/${m[1]}`, provider: "Loom" };
  }
  if (host === "vimeo.com") {
    const m = /^\/(\d+)/u.exec(url.pathname);
    if (m) return { embedUrl: `https://player.vimeo.com/video/${m[1]}`, provider: "Vimeo" };
  }
  if (host === "player.vimeo.com") return { embedUrl: safe, provider: "Vimeo" };
  if (host === "figma.com" && /^\/(file|design|proto|board|slides)\//u.test(url.pathname)) {
    return {
      embedUrl: `https://www.figma.com/embed?embed_host=pistachio&url=${encodeURIComponent(safe)}`,
      provider: "Figma",
    };
  }
  return { embedUrl: safe, provider: "Web" };
}

export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (el) => sanitizeEmbedSrc(el.getAttribute("data-src") ?? el.getAttribute("src")) ?? "",
        renderHTML: (attrs) => (attrs["src"] ? { "data-src": attrs["src"] } : {}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="embed"]' },
      // Pasted embed codes: only accept iframes whose src is a valid https URL.
      { tag: "iframe[src]", getAttrs: (el) => (sanitizeEmbedSrc(el.getAttribute("src")) ? null : false) },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = mergeAttributes({ "data-type": "embed" }, HTMLAttributes);
    const target = resolveEmbed(node.attrs["src"] as string);
    if (!target) return ["div", attrs];
    return [
      "div",
      attrs,
      [
        "iframe",
        {
          src: target.embedUrl,
          sandbox: EMBED_SANDBOX,
          allow: EMBED_ALLOW,
          loading: "lazy",
          referrerpolicy: "strict-origin-when-cross-origin",
        },
      ],
    ];
  },

  renderMarkdown(node) {
    const src = sanitizeEmbedSrc(node.attrs?.["src"] as string | undefined);
    return src ? `<${src}>` : "";
  },
});
