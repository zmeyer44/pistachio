import type { WatchtowerDocument } from "@pistachio/agent-runtime/watchtower";

/**
 * The saved page as a document in a real tab. Inert by construction: every
 * character of saved text is escaped, there is no script, and the policy
 * allows nothing to load but the app's own Geist files from this same
 * internal origin — so opening a memory never contacts the site it came from.
 *
 * It looks like the rest of the app: Geist, the gray scale, a 1px alpha rule.
 * The values are the shell's tokens (shell-ui/theme.css) written out, since a
 * served document cannot import them.
 */

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export const WATCHTOWER_DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src pistachio:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const COVERAGE: Record<WatchtowerDocument["coverage"], string> = {
  complete: "",
  partial: "Partial capture",
  metadata: "Title only",
  expired: "Text expired",
};

const STYLE = `
@font-face{font-family:"Geist";src:url("pistachio://watchtower/font/geist.woff2") format("woff2-variations");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url("pistachio://watchtower/font/geist-mono.woff2") format("woff2-variations");font-weight:100 900;font-display:swap}
:root{color-scheme:light dark;--bg:#fff;--bg-2:#fafafa;--fg:#171717;--fg-2:#666;--fg-3:#8f8f8f;--rule:rgba(0,0,0,.08);--fill:#f2f2f2;--link:#0068d6}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--bg-2:#111;--fg:#ededed;--fg-2:#a1a1a1;--fg-3:#878787;--rule:rgba(255,255,255,.14);--fill:#1a1a1a;--link:#52a8ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/1.7 "Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.bar{position:sticky;top:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:10px 20px;background:var(--bg-2);border-bottom:1px solid var(--rule);font-size:13px;line-height:18px;color:var(--fg-2)}
.bar strong{font-weight:500;color:var(--fg)}
.bar .badge{padding:1px 8px;border-radius:9999px;background:var(--fill);font-size:12px;color:var(--fg)}
.bar .links{margin-left:auto;display:flex;gap:14px}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
main{max-width:720px;margin:0 auto;padding:40px 24px 96px}
h1,h2,h3,h4,h5,h6{font-weight:600;color:var(--fg);margin:1.9em 0 .5em}
h1{font-size:32px;line-height:40px;letter-spacing:-.04em;margin-top:0}
h2{font-size:24px;line-height:32px;letter-spacing:-.03em}
h3{font-size:20px;line-height:26px;letter-spacing:-.02em}
h4,h5,h6{font-size:16px;line-height:24px;letter-spacing:-.02em}
p,ul,ol,blockquote,pre{margin:0 0 1.05em}
p{white-space:pre-line;overflow-wrap:anywhere}
ul,ol{padding-left:1.4em}
li{margin:.2em 0}
li::marker{color:var(--fg-3)}
blockquote{padding-left:14px;border-left:2px solid var(--rule);color:var(--fg-2)}
pre{padding:12px 14px;border-radius:8px;background:var(--fill);box-shadow:0 0 0 1px var(--rule);font:400 13px/20px "Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.card{margin:0 0 28px;padding:12px 14px;border-radius:8px;background:var(--bg-2);box-shadow:0 0 0 1px var(--rule);font-size:14px;line-height:20px;color:var(--fg-2)}
.card p{margin:0 0 8px}
.card p:last-child{margin:0}
.card b{font-weight:400;color:var(--fg-3);font-size:12px;margin-right:6px}
.card span{color:var(--fg);margin-right:18px}
.empty{color:var(--fg-2)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);font:400 12px/18px "Geist Mono",ui-monospace,monospace;color:var(--fg-3);overflow-wrap:anywhere}
footer p{font-family:"Geist",ui-sans-serif,system-ui,sans-serif;margin:6px 0 0}
`.replace(/\n/gu, "");

function blockHtml(block: string): string {
  if (block.startsWith("~~~~\n"))
    return `<pre><code>${escape(block.slice(5, -5))}</code></pre>`;
  const heading = /^(#{1,6}) (.+)$/su.exec(block);
  if (heading) {
    // The page's own h1 is the document's h2: the title above is the h1.
    const level = Math.min(heading[1]!.length + 1, 6);
    return `<h${level}>${escape(heading[2]!)}</h${level}>`;
  }
  if (block.startsWith("> "))
    return `<blockquote>${escape(block.slice(2))}</blockquote>`;
  const lines = block.split("\n");
  if (lines.length > 1 && lines.every((line) => /^(- |\d+\. )/u.test(line))) {
    const tag = /^\d/u.test(lines[0]!) ? "ol" : "ul";
    return `<${tag}>${lines.map((line) => `<li>${escape(line.replace(/^(- |\d+\. )/u, ""))}</li>`).join("")}</${tag}>`;
  }
  return `<p>${escape(block)}</p>`;
}

/** The card block: `# title`, then description and `Label: value` facts. */
function cardHtml(block: string): string {
  const [, ...rest] = block.split("\n\n");
  if (rest.length === 0) return "";
  return `<div class="card">${rest
    .map((part) =>
      /^(Creator|Published|Duration): /mu.test(part)
        ? `<p>${part
            .split("\n")
            .map((line) => {
              const at = line.indexOf(": ");
              return `<b>${escape(line.slice(0, at))}</b><span>${escape(line.slice(at + 2))}</span>`;
            })
            .join("")}</p>`
        : `<p>${escape(part)}</p>`,
    )
    .join("")}</div>`;
}

export function snapshotHtml(doc: WatchtowerDocument): string {
  const [card, ...body] = doc.blocks;
  const moment = (at: number): string =>
    escape(
      new Date(at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
  const coverage = COVERAGE[doc.coverage];
  const content =
    doc.blocks.length === 0
      ? `<p class="empty">${doc.coverage === "expired" ? "The saved text of this visit expired under your retention setting." : "No text was saved for this visit."}</p>`
      : `${card === undefined ? "" : cardHtml(card)}${body.map(blockHtml).join("\n")}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(doc.title)} · Watchtower</title>
<meta http-equiv="Content-Security-Policy" content="${WATCHTOWER_DOCUMENT_CSP}">
<style>${STYLE}</style></head><body>
<div class="bar"><strong>Saved page</strong><span>Visited ${moment(doc.visitedAt)}</span><span>Captured ${moment(doc.capturedAt)}</span>${coverage ? `<span class="badge">${coverage}</span>` : ""}<span class="links"><a href="${escape(doc.url)}" rel="noreferrer">Open live page</a><a href="pistachio://watchtower/v/${encodeURIComponent(doc.observationId)}/markdown">Markdown</a></span></div>
<main><h1>${escape(doc.title)}</h1>${content}<footer>${escape(doc.url)}<p>Saved text only. Images, scripts and the live site are not loaded.</p></footer></main></body></html>`;
}
