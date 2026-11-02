/**
 * The document an HTML block renders in (docs/notes.md §5): the live frame's
 * srcdoc. Free of TipTap, so a viewer can draw a block without the editor.
 */

/** Live frames run scripts in an opaque origin. Never add allow-same-origin here. */
export const HTML_BLOCK_SANDBOX = "allow-scripts";
export const HTML_BLOCK_HEIGHT_MESSAGE = "pistachio:html-block:height";

/**
 * Design tokens injected into every HTML block's base stylesheet, light and
 * dark, so a block that uses them looks native in a note. The values mirror
 * the shell's own tokens (shell-ui theme.css) and the published note's.
 */
export const HTML_BLOCK_TOKENS = {
  light: {
    "--note-fg": "#1a1a1a",
    "--note-muted": "#6b6b6b",
    "--note-faint": "#a3a3a3",
    "--note-accent": "#2563eb",
    "--note-accent-fg": "#ffffff",
    "--note-line": "rgba(0, 0, 0, 0.1)",
    "--note-surface": "#ffffff",
    "--note-surface-2": "rgba(0, 0, 0, 0.05)",
    "--note-danger": "#dc2626",
    "--note-success": "#15803d",
  },
  dark: {
    "--note-fg": "#ededed",
    "--note-muted": "#a1a1a1",
    "--note-faint": "#6b6b6b",
    "--note-accent": "#7aa2f7",
    "--note-accent-fg": "#111111",
    "--note-line": "rgba(255, 255, 255, 0.14)",
    "--note-surface": "#111111",
    "--note-surface-2": "rgba(255, 255, 255, 0.07)",
    "--note-danger": "#f87171",
    "--note-success": "#4ade80",
  },
  shape: {
    "--note-radius": "6px",
    "--note-font-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
} as const;

const declarations = (tokens: Record<string, string>) =>
  Object.entries(tokens)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");

const BASE_STYLESHEET = [
  `:root{color-scheme:light dark;${declarations(HTML_BLOCK_TOKENS.light)};${declarations(HTML_BLOCK_TOKENS.shape)}}`,
  `@media (prefers-color-scheme:dark){:root{${declarations(HTML_BLOCK_TOKENS.dark)}}}`,
  "html,body{margin:0;padding:0}",
  "body{font:15px/1.55 Geist,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--note-fg);overflow-x:auto;-webkit-font-smoothing:antialiased}",
].join("");

const HEAD = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<style>${BASE_STYLESHEET}</style>`,
].join("");

function resizeReporter(token: string): string {
  const message = `{type:"${HTML_BLOCK_HEIGHT_MESSAGE}",height:h,token:${JSON.stringify(token)}}`;
  return `<script>(function(){var last=-1;function report(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;parent.postMessage(${message},"*");}}if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement);}addEventListener("load",report);report();})();</script>`;
}

/**
 * The srcdoc for an HTML block: the person's markup plus a base stylesheet
 * (with the design tokens) and a script that reports the content height to
 * the parent via postMessage. `token` is echoed in every height message, so
 * the host can tell reports for this document from late ones sent by the
 * previous one.
 */
export function buildHtmlBlockDocument(html: string, { token = "" }: { token?: string } = {}): string {
  return ["<!doctype html><html><head>", HEAD, "</head><body>", html, resizeReporter(token), "</body></html>"].join("");
}
